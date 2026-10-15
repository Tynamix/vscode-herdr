'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { git, parseWorktrees, countChanges, inspectProject, listWorktrees, listBranches, worktreeStatus, createWorktree, removeWorktree } = require('../src/git');

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-git-test-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'main project ');
  await fs.mkdir(root);
  await git(root, ['init', '-b', 'main']);
  await fs.writeFile(path.join(root, 'original.txt'), 'original\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Herdr Test', '-c', 'user.email=herdr@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture']);
  return { directory, root };
}

test('porcelain worktrees preserve whitespace, newlines, detached state and unavailable paths', () => {
  const trees = parseWorktrees('worktree /project with spaces\0HEAD abc\0branch refs/heads/feature/a\0\0worktree /tree\nwith newline\0HEAD def\0detached\0locked maintenance\0prunable gitdir missing\0\0');
  assert.equal(trees.length, 2);
  assert.equal(trees[0].path, '/project with spaces');
  assert.equal(trees[0].branch, 'feature/a');
  assert.equal(trees[1].path, '/tree\nwith newline');
  assert.equal(trees[1].detached, true);
  assert.equal(trees[1].locked, 'maintenance');
  assert.equal(trees[1].prunable, 'gitdir missing');
});

test('change counts treat rename pairs as one file', () => {
  assert.equal(countChanges('R  renamed.txt\0old.txt\0 M modified.txt\0?? new\nfile.txt\0'), 3);
  assert.equal(countChanges(''), 0);
});

test('lists local and remote source branches with explicit refs and excludes remote HEAD aliases', async t => {
  const { root } = await fixture(t);
  await git(root, ['branch', 'origin/main']);
  await git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  assert.deepEqual(await listBranches(root), [
    { ref: 'refs/heads/main', name: 'main', remote: false, current: true },
    { ref: 'refs/heads/origin/main', name: 'origin/main', remote: false, current: false },
    { ref: 'refs/remotes/origin/main', name: 'origin/main', remote: true, current: false }
  ]);
  await git(root, ['checkout', '--detach']);
  assert.ok((await listBranches(root)).every(branch => !branch.current));
});

test('new worktrees branch from the selected local or remote source instead of HEAD or an ambiguous tag', async t => {
  const { directory, root } = await fixture(t);
  await git(root, ['checkout', '-b', 'source']);
  await fs.writeFile(path.join(root, 'original.txt'), 'source branch\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Herdr Test', '-c', 'user.email=herdr@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Source change']);
  const sourceCommit = (await git(root, ['rev-parse', 'HEAD'])).trim();
  await git(root, ['update-ref', 'refs/remotes/origin/source', sourceCommit]);
  await git(root, ['checkout', 'main']);
  await git(root, ['tag', 'source']);

  const sources = (await listBranches(root)).filter(branch => branch.name === 'source' || branch.name === 'origin/source');
  assert.equal(sources.length, 2);
  for (const [index, source] of sources.entries()) {
    const destination = path.join(directory, `selected source ${index}`);
    await createWorktree(root, destination, `feature/from-source-${index}`, source.ref);
    assert.equal((await git(destination, ['rev-parse', 'HEAD'])).trim(), sourceCommit);
    assert.equal(await fs.readFile(path.join(destination, 'original.txt'), 'utf8'), 'source branch\n');
  }
  assert.equal(await fs.readFile(path.join(root, 'original.txt'), 'utf8'), 'original\n');
});

test('discovers linked worktrees and deduplicates their project identity', async t => {
  const { directory, root } = await fixture(t);
  const linked = path.join(directory, 'feature worktree');
  await createWorktree(root, linked, 'feature/parallel');
  const main = await inspectProject(root);
  const child = await inspectProject(linked);
  assert.equal(main.id, child.id);
  assert.equal(main.name, child.name);
  assert.equal(main.path, await fs.realpath(root));
  const trees = await listWorktrees(linked);
  assert.equal(trees.length, 2);
  assert.equal(trees[1].branch, 'feature/parallel');
  await fs.writeFile(path.join(linked, 'a new file.txt'), 'new\n');
  assert.equal((await worktreeStatus(trees[1])).changedFiles, 1);
  assert.equal((await worktreeStatus(trees[0])).changedFiles, 0);
});

test('detects real staged renames, deleted files and detached HEAD', async t => {
  const { directory, root } = await fixture(t);
  const linked = path.join(directory, 'detached tree');
  await git(root, ['worktree', 'add', '--detach', linked, 'HEAD']);
  await git(root, ['mv', 'original.txt', 'renamed.txt']);
  assert.equal((await worktreeStatus((await listWorktrees(root))[0])).changedFiles, 1);
  await fs.unlink(path.join(linked, 'original.txt'));
  const detached = (await listWorktrees(root))[1];
  assert.equal(detached.detached, true);
  assert.equal((await worktreeStatus(detached)).changedFiles, 1);
});

test('counts individual untracked files in new directories and excludes ignored files', async t => {
  const { root } = await fixture(t);
  const directory = path.join(root, 'new api', 'payment');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'attempt.ts'), 'attempt\n');
  await fs.writeFile(path.join(directory, 'confirm.ts'), 'confirm\n');
  await fs.appendFile(path.join(root, '.git', 'info', 'exclude'), '\nignored.tmp\n');
  await fs.writeFile(path.join(directory, 'ignored.tmp'), 'generated\n');
  const tree = (await listWorktrees(root))[0];
  assert.equal(countChanges(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])), 1);
  assert.equal((await worktreeStatus(tree)).changedFiles, 2);
});

test('invalid branches, refs and existing destinations fail without losing files', async t => {
  const { directory, root } = await fixture(t);
  const destination = path.join(directory, 'never-created');
  await assert.rejects(createWorktree(root, destination, '--force'), /valid/);
  await assert.rejects(createWorktree(root, destination, 'bad branch'));
  await assert.rejects(createWorktree(root, destination, 'valid-branch', '--bad-ref'));
  await assert.rejects(fs.access(destination));
  await assert.rejects(createWorktree(root, root, 'existing-path'));
  assert.equal(await fs.readFile(path.join(root, 'original.txt'), 'utf8'), 'original\n');
});

test('removes only the selected linked worktree and preserves its branch and the main checkout', async t => {
  const { directory, root } = await fixture(t);
  const linked = path.join(directory, 'feature with spaces');
  const other = path.join(directory, 'other worktree');
  await createWorktree(root, linked, 'feature/remove');
  await createWorktree(root, other, 'feature/keep');
  const trees = await listWorktrees(linked);
  assert.equal(trees[0].isMain, true);
  assert.equal(trees.find(tree => tree.path === linked)?.isMain, false);
  await removeWorktree(root, linked);
  await assert.rejects(fs.access(linked));
  assert.equal((await listWorktrees(root)).length, 2);
  assert.ok((await listBranches(root)).some(branch => branch.name === 'feature/remove'));
  assert.equal(await fs.readFile(path.join(root, 'original.txt'), 'utf8'), 'original\n');
  assert.equal(await fs.readFile(path.join(other, 'original.txt'), 'utf8'), 'original\n');
});

test('refuses main, unknown, locked and dirty worktrees without losing files', async t => {
  const { directory, root } = await fixture(t);
  const linked = path.join(directory, 'protected worktree');
  await createWorktree(root, linked, 'feature/protected');
  const primary = (await listWorktrees(root))[0].path;
  await assert.rejects(removeWorktree(linked, primary), /main checkout/);
  await assert.rejects(removeWorktree(root, directory), /no longer available/);
  await git(root, ['worktree', 'lock', linked]);
  await assert.rejects(removeWorktree(root, linked), /locked/);
  await git(root, ['worktree', 'unlock', linked]);
  await fs.writeFile(path.join(linked, 'original.txt'), 'uncommitted\n');
  await assert.rejects(removeWorktree(root, linked));
  assert.equal(await fs.readFile(path.join(linked, 'original.txt'), 'utf8'), 'uncommitted\n');
  await git(linked, ['checkout', '--', 'original.txt']);
  await fs.writeFile(path.join(linked, 'untracked.txt'), 'untracked\n');
  await assert.rejects(removeWorktree(root, linked));
  assert.equal(await fs.readFile(path.join(linked, 'untracked.txt'), 'utf8'), 'untracked\n');
  assert.equal((await listWorktrees(root)).length, 2);
});

test('removes a missing linked worktree registration without pruning other entries', async t => {
  const { directory, root } = await fixture(t);
  const linked = path.join(directory, 'missing tree');
  await createWorktree(root, linked, 'feature/missing');
  await fs.rm(linked, { recursive: true });
  assert.ok((await listWorktrees(root)).find(tree => tree.path === linked).prunable);
  await removeWorktree(root, linked);
  assert.equal((await listWorktrees(root)).length, 1);
  assert.ok((await listBranches(root)).some(branch => branch.name === 'feature/missing'));
});
