'use strict';

const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { git, createWorktree } = require('../src/git');

async function until(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for VS Code.');
}

async function run() {
  if (process.env.HERDR_TEST_RESTORE) return restore();
  const checks = [];
  let backendSession;
  try {
    const extension = vscode.extensions.getExtension('herdr-workbench.vscode-herdr');
    assert.ok(extension, 'Development extension is registered');
    const api = await extension.activate();
    await vscode.commands.executeCommand('herdr.addProject', vscode.Uri.file(process.env.HERDR_TEST_REPO));
    await vscode.commands.executeCommand('herdr.addProject', vscode.Uri.file(process.env.HERDR_TEST_TREE));
    let data = api.getSnapshot();
    assert.equal(data.projects.length, 1);
    assert.equal(data.projects[0].worktrees.length, 2);
    checks.push('Extension activates and deduplicates main + linked worktree');
    const worktree = data.projects[0].worktrees.find(w => w.branch === 'feature/smoke');
    assert.equal(worktree.changedFiles, 1);
    await vscode.commands.executeCommand('herdr.selectWorktree', { worktreePath: worktree.path });
    assert.equal(api.getSnapshot().selectedWorktree, worktree.path);
    const gitExtension = await vscode.extensions.getExtension('vscode.git').activate();
    const gitApi = gitExtension.getAPI(1);
    let repository = gitApi.repositories.find(repo => repo.rootUri.fsPath === worktree.path);
    assert.ok(repository, 'Native Git extension opened the selected worktree');
    assert.equal(repository.state.workingTreeChanges.length, 1);
    await vscode.commands.executeCommand('herdr.openChange', { change: repository.state.workingTreeChanges[0], staged: false });
    await until(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff)));
    checks.push('Worktree selection opens its native Git repository and native file diff');

    const primary = data.projects[0].worktrees.find(tree => tree.branch === 'main');
    const mainOnly = path.join(primary.path, 'main-only.txt');
    const treeOnly = path.join(worktree.path, 'tree-only.txt');
    await fs.writeFile(mainOnly, 'main changes stay in main\n');
    await fs.writeFile(treeOnly, 'branch changes stay in the branch\n');
    const cleanPath = path.join(path.dirname(worktree.path), 'clean tree');
    await createWorktree(primary.path, cleanPath, 'feature/clean');
    await api.refresh();
    const clean = api.getSnapshot().projects[0].worktrees.find(tree => tree.branch === 'feature/clean');
    const backgroundTerminal = vscode.window.createTerminal({ name: 'Herdr switch regression', cwd: worktree.path });

    async function verifyWorktreeSelection(tree, expectedFiles) {
      await vscode.commands.executeCommand('herdr.selectWorktree', { worktreePath: tree.path });
      try {
        await until(() => gitApi.repositories.length === 1 && gitApi.repositories[0].rootUri.fsPath === tree.path, 5000);
      } catch {
        throw new Error(JSON.stringify({ expectedWorktree: tree.path, nativeRepositories: gitApi.repositories.map(repo => repo.rootUri.fsPath), selectedWorktree: api.getSnapshot().selectedWorktree }));
      }
      const selected = api.getSnapshot();
      assert.equal(selected.selectedWorktree, tree.path);
      assert.equal(selected.changes.worktreePath, tree.path);
      assert.deepEqual([...new Set(selected.changes.files.map(file => file.path))].sort(), [...expectedFiles].sort());
      const native = gitApi.repositories[0];
      const nativeChanges = [...native.state.indexChanges, ...native.state.workingTreeChanges, ...(native.state.untrackedChanges || [])];
      assert.deepEqual([...new Set(nativeChanges.map(change => change.uri.fsPath))].sort(), [...expectedFiles].sort());
      await until(() => native.ui.selected);
      assert.ok(vscode.window.terminals.includes(backgroundTerminal), 'Switching Git views preserves the other terminal');
    }

    const branchFiles = [path.join(worktree.path, 'example.txt'), treeOnly];
    await verifyWorktreeSelection(primary, [mainOnly]);
    gitApi.repositories[0].inputBox.value = 'Commit draft for main';
    await verifyWorktreeSelection(worktree, branchFiles);
    gitApi.repositories[0].inputBox.value = 'Commit draft for branch';
    await verifyWorktreeSelection(clean, []);
    await verifyWorktreeSelection(primary, [mainOnly]);
    assert.equal(gitApi.repositories[0].inputBox.value, 'Commit draft for main');
    await verifyWorktreeSelection(worktree, branchFiles);
    assert.equal(gitApi.repositories[0].inputBox.value, 'Commit draft for branch');

    // A provider discovered after selection must not accumulate in Source Control.
    await gitApi.openRepository(vscode.Uri.file(clean.path));
    await until(() => gitApi.repositories.length === 1 && gitApi.repositories[0].rootUri.fsPath === worktree.path);
    await Promise.all([
      vscode.commands.executeCommand('herdr.selectWorktree', { worktreePath: primary.path }),
      vscode.commands.executeCommand('herdr.selectWorktree', { worktreePath: clean.path }),
      vscode.commands.executeCommand('herdr.selectWorktree', { worktreePath: worktree.path })
    ]);
    await verifyWorktreeSelection(worktree, branchFiles);
    assert.equal(await fs.readFile(mainOnly, 'utf8'), 'main changes stay in main\n');
    assert.equal(await fs.readFile(treeOnly, 'utf8'), 'branch changes stay in the branch\n');
    backgroundTerminal.dispose();
    repository = gitApi.repositories[0];
    checks.push('Switching between two dirty worktrees and a clean worktree isolates native Git and Herdr changes, including rapid switches and late discovery; files and terminals stay intact');

    async function verifyDiff(change, staged, expectedLeft, expectedRight) {
      await vscode.commands.executeCommand('herdr.openChange', { change, staged });
      const input = await until(() => {
        const value = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return value instanceof vscode.TabInputTextDiff ? value : undefined;
      });
      const left = await vscode.workspace.openTextDocument(input.original);
      const right = await vscode.workspace.openTextDocument(input.modified);
      assert.equal(left.getText(), expectedLeft);
      assert.equal(right.getText(), expectedRight);
    }
    const before = await repository.show('HEAD', 'example.txt');
    const after = before.replace('before', 'after');
    await verifyDiff(repository.state.workingTreeChanges[0], false, before, after);
    await git(worktree.path, ['mv', 'example.txt', 'renamed.txt']);
    await repository.status();
    assert.equal(repository.state.indexChanges[0].status, 3, 'Staged rename recognized');
    // git mv preserves the indexed contents; the edit remains unstaged.
    await verifyDiff(repository.state.indexChanges[0], true, before, before);
    await verifyDiff(repository.state.workingTreeChanges[0], false, before, after);
    await git(worktree.path, ['add', 'renamed.txt']);
    await fs.unlink(path.join(worktree.path, 'renamed.txt'));
    await git(worktree.path, ['add', '-u']);
    await repository.status();
    await verifyDiff(repository.state.indexChanges[0], true, before, '');
    const newFile = path.join(worktree.path, 'new.txt');
    await fs.writeFile(newFile, 'new content\n');
    await repository.status();
    const untracked = [...repository.state.workingTreeChanges, ...(repository.state.untrackedChanges || [])].find(change => change.uri.fsPath === newFile);
    assert.ok(untracked, 'Untracked file recognized');
    await verifyDiff(untracked, false, '', 'new content\n');
    await git(worktree.path, ['add', 'new.txt']);
    await repository.status();
    await verifyDiff(repository.state.indexChanges.find(change => change.uri.fsPath === newFile), true, '', 'new content\n');
    checks.push('Native diffs preserve contents for working changes, staged renames, staged deletions, new and staged files');
    await vscode.commands.executeCommand('herdr.addToWorkspace', { worktreePath: worktree.path });
    await until(() => vscode.workspace.workspaceFolders.length === 2);
    assert.equal(vscode.workspace.workspaceFolders[0].uri.fsPath, process.env.HERDR_TEST_REPO);
    checks.push('Multi-root adds the worktree and preserves the original project');
    const session = await vscode.commands.executeCommand('herdr.startSession', { worktreePath: worktree.path, profileId: 'smoke' });
    backendSession = session.backendSession;
    const current = () => api.getSnapshot().sessions.find(s => s.id === session.id);
    await until(() => current()?.indicator.state === 'idle');
    data = api.getSnapshot();
    const finished = data.sessions.find(s => s.id === session.id);
    assert.equal(finished.backend, 'herdr');
    assert.equal(finished.worktreePath, worktree.path);
    assert.equal((await fs.readFile(path.join(worktree.path, '.herdr-smoke-cwd'), 'utf8')).trim(), await fs.realpath(worktree.path));
    let terminal = vscode.window.terminals.find(t => t.name === finished.terminalName);
    assert.ok(terminal, 'Real herdr-backed integrated terminal was created');
    terminal.sendText('work', true);
    await until(() => current()?.indicator.state === 'working');
    terminal.sendText('block', true);
    await until(() => current()?.indicator.state === 'blocked');
    assert.equal(current().indicator.color, 'charts.yellow');
    terminal.sendText('answer', true);
    await until(() => current()?.indicator.state === 'working');
    terminal.sendText('done', true);
    await until(() => current()?.indicator.state === 'done');
    assert.equal(current().indicator.color, 'charts.blue');
    await vscode.commands.executeCommand('herdr.focusSession', session.id);
    await until(() => current()?.indicator.state === 'idle');
    checks.push('Real herdr-backed VS Code terminal runs in the chosen worktree and displays working, yellow question, blue completion and acknowledged idle');
    terminal.dispose();
    await until(() => !current()?.terminalAttached);
    assert.equal(current().connected, true, 'Agent remains alive with no terminal view');
    await vscode.commands.executeCommand('herdr.focusSession', session.id);
    terminal = vscode.window.terminals.find(t => t.name === finished.terminalName);
    assert.ok(terminal, 'Existing session reopened');
    assert.equal((await fs.readFile(path.join(worktree.path, '.herdr-smoke-launches'), 'utf8')).trim(), 'launch');
    await vscode.commands.executeCommand('herdr.stopSession', session.id);
    await until(() => !current()?.connected);
    await vscode.commands.executeCommand('herdr.deleteSession', session.id);
    assert.equal(api.getSnapshot().sessions.length, 0);
    await vscode.commands.executeCommand('herdr.overview');
    checks.push('Closing/reopening the terminal preserves one agent process; explicit stop, session deletion and dashboard succeed');
    const persistent = await vscode.commands.executeCommand('herdr.startSession', { worktreePath: worktree.path, profileId: 'smoke' });
    const persistentTerminal = vscode.window.terminals.find(t => t.name === persistent.terminalName);
    await until(() => api.getSnapshot().sessions.find(s => s.id === persistent.id)?.indicator.state === 'idle');
    persistentTerminal.sendText('work', true);
    await until(() => api.getSnapshot().sessions.find(s => s.id === persistent.id)?.indicator.state === 'working');
    await vscode.commands.executeCommand('herdr.refresh');
    await fs.writeFile(process.env.HERDR_TEST_RESULT, JSON.stringify({ ok: true, checks, backendSession, persistentId: persistent.id }));
  } catch (error) {
    await fs.writeFile(process.env.HERDR_TEST_RESULT, JSON.stringify({ ok: false, checks, backendSession, error: error.stack || String(error) }));
    throw error;
  }
}

async function restore() {
  const checks = [];
  try {
    const extension = vscode.extensions.getExtension('herdr-workbench.vscode-herdr');
    const api = await extension.activate();
    const id = process.env.HERDR_TEST_RESTORE;
    const current = () => api.getSnapshot().sessions.find(s => s.id === id);
    await until(() => current()?.connected && current()?.indicator.state === 'working');
    assert.equal(current().terminalAttached, false, 'Daemon survived without a terminal renderer');
    const launchesBefore = await fs.readFile(path.join(current().worktreePath, '.herdr-smoke-launches'), 'utf8');
    await vscode.commands.executeCommand('herdr.focusSession', id);
    const terminal = vscode.window.terminals.find(t => t.name === current().terminalName);
    assert.ok(terminal, 'Restored session attaches to a fresh terminal renderer');
    assert.equal(await fs.readFile(path.join(current().worktreePath, '.herdr-smoke-launches'), 'utf8'), launchesBefore);
    terminal.sendText('done', true);
    await until(() => current()?.indicator.state === 'done');
    await vscode.commands.executeCommand('herdr.focusSession', id);
    await until(() => current()?.indicator.state === 'idle');
    await vscode.commands.executeCommand('herdr.stopSession', id);
    await vscode.commands.executeCommand('herdr.deleteSession', id);
    checks.push('After closing the entire test window, reopening the saved workspace reconnects the same working process without replaying its command; completion and cleanup still work');
    await fs.writeFile(process.env.HERDR_TEST_RESULT, JSON.stringify({ ok: true, checks }));
  } catch (error) {
    await fs.writeFile(process.env.HERDR_TEST_RESULT, JSON.stringify({ ok: false, checks, error: error.stack || String(error) }));
    throw error;
  }
}

module.exports = { run };
