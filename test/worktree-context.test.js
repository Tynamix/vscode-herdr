'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WorktreeContext } = require('../src/worktree-context');

const uri = file => ({ fsPath: file, toString: () => 'file://' + file });
function memento(values = {}) {
  return { values, keys: () => Object.keys(values), get: (key, fallback) => values[key] ?? fallback,
    async update(key, value) { if (value === undefined) delete values[key]; else values[key] = structuredClone(value); } };
}
async function fixture(t, { folderWindow = false, enabled = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-context-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = { 'herdr.switchWorkspaceOnSelect': enabled, 'herdr.agentProfiles': [] };
  const mutations = [];
  const workspaceState = memento({ projects: [{ id: 'one' }, { id: 'two' }], sessions: [{ id: 'session' }], herdrBackendSession: 'vscode-original' });
  const globalState = memento();
  const context = { workspaceState, globalState, globalStorageUri: uri(directory) };
  const vscode = { env: { sessionId: 'window-one' }, Uri: { file: uri }, ConfigurationTarget: { Workspace: 2 },
    workspace: {
      workspaceFile: folderWindow ? undefined : uri(path.join(directory, 'test.code-workspace')),
      workspaceFolders: [{ uri: uri('/old/web') }, { uri: uri('/old/feature') }],
      getConfiguration(section) {
        const key = name => section ? section + '.' + name : name;
        return { get: (name, fallback) => settings[key(name)] ?? fallback,
          inspect: name => ({ workspaceValue: settings[key(name)] }),
          async update(name, value, target) { assert.equal(target, 2); settings[key(name)] = value; } };
      },
      updateWorkspaceFolders(...args) { mutations.push(args); return true; }
    },
    commands: { async executeCommand(...args) { mutations.push(args); } }
  };
  return { context, vscode, settings, mutations, manager: new WorktreeContext(vscode, context) };
}
const resolved = { project: { name: 'timi' }, worktree: { path: '/project/timi', branch: 'main' } };

test('only the selected root remains; terminal defaults can be restored without changing user settings', async t => {
  const { manager, settings, mutations, context } = await fixture(t);
  assert.equal(await manager.switch(resolved), true);
  assert.equal(mutations[0][0], 0);
  assert.equal(mutations[0][1], 2);
  assert.equal(mutations[0].length, 3);
  assert.equal(mutations[0][2].uri.fsPath, resolved.worktree.path);
  assert.equal(settings['terminal.integrated.cwd'], resolved.worktree.path);
  assert.equal(settings['terminal.integrated.splitCwd'], 'workspaceRoot');
  assert.equal(context.workspaceState.get('herdrBackendSession'), 'vscode-original');
  await manager.releaseTerminalDirectory();
  assert.equal(settings['terminal.integrated.cwd'], undefined);
});

test('a folder window converts in place so VS Code retains ordinary terminals and workspace storage', async t => {
  const { manager, mutations, vscode, context } = await fixture(t, { folderWindow: true });
  vscode.workspace.workspaceFolders = [vscode.workspace.workspaceFolders[0]];
  assert.equal(await manager.switch(resolved), true);
  assert.equal(mutations[0][0], 1);
  assert.equal(mutations[0][1], 0);
  assert.equal(mutations[0][2].uri.fsPath, resolved.worktree.path);
  const next = { globalState: context.globalState, workspaceState: memento() };
  vscode.workspace.workspaceFile = uri('/untitled/workspace.code-workspace');
  vscode.workspace.workspaceFolders.push({ uri: uri(resolved.worktree.path) });
  await WorktreeContext.restore(vscode, next);
  assert.equal(next.workspaceState.get('herdrBackendSession'), 'vscode-original');
  assert.deepEqual(next.workspaceState.get('projects'), context.workspaceState.get('projects'));
  assert.deepEqual(context.globalState.get('worktreeFolderTransfers'), {});
});

test('an empty window transfers the complete Herdr catalog to the exact new named workspace', async t => {
  const { manager, mutations, context, vscode } = await fixture(t, { folderWindow: true });
  vscode.workspace.workspaceFolders = [];
  context.workspaceState.values.worktreeContextAction = { type: 'session', sessionId: 'session' };
  assert.equal(await manager.switch(resolved), true);
  const [command, target, options] = mutations[0];
  assert.equal(command, 'vscode.openFolder');
  assert.equal(options.forceReuseWindow, true);
  const document = JSON.parse(await fs.readFile(target.fsPath));
  assert.deepEqual(document.folders, [{ path: '/project/timi', name: 'timi · main' }]);
  assert.equal(document.settings['terminal.integrated.cwd'], resolved.worktree.path);
  const next = { globalState: context.globalState, workspaceState: memento() };
  await WorktreeContext.restore(vscode, next);
  assert.equal(next.workspaceState.keys().length, 0, 'Transfer is not applied to another workspace');
  vscode.workspace.workspaceFile = target;
  await WorktreeContext.restore(vscode, next);
  assert.deepEqual(next.workspaceState.get('projects'), context.workspaceState.get('projects'));
  assert.deepEqual(next.workspaceState.get('sessions'), [{ id: 'session' }]);
  assert.equal(next.workspaceState.get('herdrBackendSession'), 'vscode-original');
  assert.deepEqual(next.workspaceState.get('worktreeContextAction'), { type: 'session', sessionId: 'session' });
  assert.deepEqual(context.globalState.get('worktreeWorkspaceTransfers'), {});
});

test('an already selected root needs no reload; disabling workspace switching preserves multiple roots', async t => {
  const first = await fixture(t);
  first.vscode.workspace.workspaceFolders = [{ uri: uri(resolved.worktree.path) }];
  assert.equal(await first.manager.switch(resolved), false);
  assert.equal(first.mutations.length, 0);
  const second = await fixture(t, { enabled: false });
  assert.equal(await second.manager.switch(resolved), false);
  assert.equal(second.mutations.length, 0);
  assert.equal(second.settings['terminal.integrated.cwd'], undefined);
});

test('superseded selections and rejected folder mutations do not claim a successful switch', async t => {
  const { manager, vscode, mutations } = await fixture(t);
  assert.equal(await manager.switch(resolved, () => false), false);
  assert.equal(mutations.length, 0);
  vscode.workspace.updateWorkspaceFolders = () => false;
  await assert.rejects(manager.switch(resolved), /could not/);
  assert.equal(manager.switching, false);
});

test('workspace restoration batches independent state updates and retains the transfer until all are saved', async t => {
  const { context, vscode } = await fixture(t);
  const key = vscode.workspace.workspaceFile.toString();
  const values = { projects: [{ id: 'one' }], sessions: [{ id: 'session' }], selectedWorktree: '/project' };
  await context.globalState.update('worktreeWorkspaceTransfers', { [key]: values });
  const workspaceState = memento();
  const update = workspaceState.update;
  const pending = [];
  workspaceState.update = (name, value) => new Promise(resolve => {
    pending.push({ name, async finish() { await update(name, value); resolve(); } });
  });
  const restored = WorktreeContext.restore(vscode, { globalState: context.globalState, workspaceState });
  assert.deepEqual(pending.map(update => update.name), Object.keys(values));
  await Promise.all(pending.slice(1).map(update => update.finish()));
  assert.deepEqual(context.globalState.get('worktreeWorkspaceTransfers'), { [key]: values });
  await pending[0].finish();
  await restored;
  assert.deepEqual(workspaceState.values, values);
  assert.deepEqual(context.globalState.get('worktreeWorkspaceTransfers'), {});
});

test('a failed workspace-state restoration keeps its transfer available for retry', async t => {
  const { context, vscode } = await fixture(t);
  const key = vscode.workspace.workspaceFile.toString();
  const values = { projects: [{ id: 'one' }], sessions: [{ id: 'session' }] };
  await context.globalState.update('worktreeWorkspaceTransfers', { [key]: values });
  const workspaceState = memento();
  workspaceState.update = async () => { throw new Error('Storage unavailable'); };
  await assert.rejects(WorktreeContext.restore(vscode, { globalState: context.globalState, workspaceState }), /Storage unavailable/);
  assert.deepEqual(context.globalState.get('worktreeWorkspaceTransfers'), { [key]: values });
});
