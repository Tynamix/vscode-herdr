'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const execute = promisify(execFile);

async function git(cwd, args, options = {}) {
  try {
    const { stdout } = await execute('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      ...options
    });
    return stdout;
  } catch (error) {
    throw new Error((error.stderr || error.message).trim(), { cause: error });
  }
}

function parseWorktrees(output) {
  const trees = [];
  let current;
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      if (current) trees.push(current);
      current = { path: field.slice(9), branch: '', detached: false, bare: false };
    } else if (current && field.startsWith('branch ')) {
      current.branch = field.slice(7).replace(/^refs\/heads\//, '');
    } else if (current && field.startsWith('HEAD ')) {
      current.head = field.slice(5);
    } else if (current && field === 'detached') {
      current.detached = true;
    } else if (current && field === 'bare') {
      current.bare = true;
    } else if (current && /^(locked|prunable)( |$)/.test(field)) {
      const key = field.startsWith('locked') ? 'locked' : 'prunable';
      current[key] = field.slice(key.length + 1) || true;
    }
  }
  if (current) trees.push(current);
  return trees;
}

function countChanges(output) {
  const entries = output.split('\0');
  let count = 0;
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    count++;
    // Porcelain -z stores the second path of a rename/copy as a separate field.
    if (/[RC]/.test(entries[i].slice(0, 2))) i++;
  }
  return count;
}

async function listWorktrees(cwd) {
  return parseWorktrees(await git(cwd, ['worktree', 'list', '--porcelain', '-z']))
    .map((tree, index) => ({ ...tree, isMain: index === 0 && !tree.bare })).filter(tree => !tree.bare);
}

async function listBranches(cwd) {
  const output = await git(cwd, ['for-each-ref', '--format=%(refname)%00%(symref)%00%(HEAD)', 'refs/heads/', 'refs/remotes/']);
  return output.split('\n').filter(Boolean).flatMap(line => {
    const [ref, symbolic, head] = line.split('\0');
    if (symbolic) return [];
    const remote = ref.startsWith('refs/remotes/');
    return [{ ref, name: ref.replace(/^refs\/(heads|remotes)\//, ''), remote, current: head === '*' }];
  }).sort((a, b) => Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name));
}

async function inspectProject(cwd) {
  const input = await fs.realpath(cwd);
  const root = (await git(input, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
  const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).replace(/\r?\n$/, '');
  const trees = await listWorktrees(root);
  return { id: await fs.realpath(common), path: root, name: path.basename(trees[0]?.path || root) };
}

async function worktreeStatus(tree) {
  if (tree.prunable) return { ...tree, error: 'Worktree no longer exists on the filesystem.' };
  try {
    const status = await git(tree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return { ...tree, changedFiles: countChanges(status) };
  } catch (error) {
    return { ...tree, error: error.message };
  }
}

async function createWorktree(cwd, destination, branch, base = 'HEAD') {
  if (!branch || branch.startsWith('-')) throw new Error('Enter a valid new branch name.');
  await git(cwd, ['check-ref-format', '--branch', branch]);
  const commit = (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim();
  await git(cwd, ['worktree', 'add', '-b', branch, '--', path.resolve(destination), commit], { timeout: 60000 });
  return listWorktrees(cwd);
}

async function removeWorktree(cwd, target) {
  const worktree = (await listWorktrees(cwd)).find(tree => path.resolve(tree.path) === path.resolve(target));
  if (!worktree) throw new Error('This worktree is no longer available. Refresh the view.');
  if (worktree.isMain) throw new Error('The main checkout cannot be deleted as a worktree.');
  if (worktree.locked) throw new Error('This worktree is locked. Unlock it in Git first.');
  // Git refuses dirty worktrees, untracked files and submodules without force.
  await git(cwd, ['worktree', 'remove', '--', worktree.path], { timeout: 60000 });
}

module.exports = { git, parseWorktrees, countChanges, listWorktrees, listBranches, inspectProject, worktreeStatus, createWorktree, removeWorktree };
