'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const git = require('../src/git');

async function fixture(t, { addedThroughLinked = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-delete-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'main');
  const linked = path.join(directory, 'linked');
  await fs.mkdir(root);
  await git.git(root, ['init', '-b', 'main']);
  await fs.writeFile(path.join(root, 'file.txt'), 'committed\n');
  await git.git(root, ['add', '.']);
  await git.git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture']);
  await git.createWorktree(root, linked, 'feature/delete');
  const project = await git.inspectProject(addedThroughLinked ? linked : root);
  const data = { projects: [project] };
  const commands = new Map();
  const providers = new Map();
  const disposable = () => ({ dispose() {} });
  const ui = { response: undefined, warnings: [], errors: [], duringConfirm: () => {}, removals: [] };
  let sessions;
  class MemorySessions {
    constructor() { sessions = this; this.items = []; this.live = new Map(); }
    async refresh() {}
    find(id) { return this.items.find(item => item.id === id); }
    async remove(id) { ui.removals.push(id); }
  }
  class MemoryChanges {
    async saveDrafts() {}
    async select(worktree) { this.repository = { rootUri: { fsPath: worktree.path } }; return true; }
    getChildren() { return []; }
  }
  class MemoryWorktreeContext {
    static async restore() {}
    enabled() { return false; }
    async switch() { return false; }
  }
  const workspace = {
    textDocuments: [], workspaceFolders: [{ uri: { fsPath: linked } }],
    getConfiguration: () => ({ get: (_name, fallback) => fallback }),
    onDidSaveTextDocument: disposable, onDidChangeWorkspaceFolders: disposable, onDidChangeConfiguration: disposable,
    updateWorkspaceFolders(index, count) { workspace.workspaceFolders.splice(index, count); return true; }
  };
  const vscode = {
    workspace, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 1 },
    EventEmitter: class { event() {} fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { Expanded: 2 }, ThemeIcon: class {}, ThemeColor: class {},
    commands: { registerCommand(name, handler) { commands.set(name, handler); return disposable(); },
      executeCommand: (name, ...args) => commands.get(name)?.(...args) },
    window: {
      createOutputChannel: () => ({ ...disposable(), appendLine() {} }),
      createStatusBarItem: () => ({ ...disposable(), show() {} }),
      createTreeView(name, options) { providers.set(name, options.treeDataProvider); return disposable(); },
      onDidChangeWindowState: disposable,
      showErrorMessage: message => ui.errors.push(message),
      async showWarningMessage(_message, options, action) {
        ui.warnings.push({ options, action });
        await ui.duringConfirm();
        return ui.response;
      },
      withProgress: (_options, operation) => operation()
    }
  };
  const context = { subscriptions: [], workspaceState: {
    get: (key, fallback) => data[key] ?? fallback, update: async (key, value) => { data[key] = structuredClone(value); }
  } };
  const filename = path.join(__dirname, '../src/extension.js');
  const actualRequire = createRequire(filename);
  const overrides = { vscode, './sessions': { Sessions: MemorySessions },
    './changes': { Changes: MemoryChanges }, './worktree-context': { WorktreeContext: MemoryWorktreeContext } };
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
    module, require: name => overrides[name] || actualRequire(name), setTimeout, clearTimeout, setInterval, clearInterval
  }, { filename });
  const api = await module.exports.activate(context);
  t.after(() => { for (const item of context.subscriptions) item.dispose(); });
  await api.refresh();
  const execute = (name, input = { worktreePath: linked }) => commands.get(name)(input);
  return { root, linked, data, ui, api, execute, sessions, workspace, providers };
}

test('cancelled worktree deletion preserves the folder, branch and catalog', async t => {
  const { linked, ui, execute, api } = await fixture(t);
  await execute('herdr.deleteWorktree');
  assert.equal(ui.warnings.length, 1);
  await fs.access(linked);
  assert.equal(api.getSnapshot().projects[0].worktrees.length, 2);
});

test('deleting the selected worktree restores the remaining checkout and a project added through the linked folder', async t => {
  const { root, linked, ui, execute, api, data, workspace } = await fixture(t, { addedThroughLinked: true });
  await execute('herdr.selectWorktree');
  ui.response = 'Worktree löschen';
  await execute('herdr.deleteWorktree');
  await assert.rejects(fs.access(linked));
  assert.equal(api.getSnapshot().selectedWorktree, root);
  assert.equal(api.getSnapshot().changes.worktreePath, root);
  assert.equal(data.projects[0].path, root);
  assert.equal(data.selectedWorktree, root);
  assert.equal(workspace.workspaceFolders.length, 0);
  assert.ok((await git.listBranches(root)).some(branch => branch.name === 'feature/delete'));
});

test('worktree deletion refuses background agents, dirty editors and changes that appear during confirmation', async t => {
  const { root, linked, ui, execute, sessions, workspace } = await fixture(t);
  sessions.items.push({ id: 'background', backend: 'herdr', worktreePath: linked, backendAlive: true });
  await assert.rejects(execute('herdr.deleteWorktree'), /Sessions dieses Worktrees/);
  sessions.items = [];
  workspace.textDocuments.push({ isDirty: true, uri: { scheme: 'file', fsPath: path.join(linked, 'file.txt') } });
  await assert.rejects(execute('herdr.deleteWorktree'), /ungesicherten Dateien/);
  workspace.textDocuments = [];
  ui.response = 'Worktree löschen';
  ui.duringConfirm = () => fs.writeFile(path.join(linked, 'file.txt'), 'changed during confirmation\n');
  await assert.rejects(execute('herdr.deleteWorktree'), /ungesicherte Änderungen/);
  assert.equal(await fs.readFile(path.join(linked, 'file.txt'), 'utf8'), 'changed during confirmation\n');
  await assert.rejects(execute('herdr.deleteWorktree', { worktreePath: root }), /Hauptcheckout/);
});

test('session trash confirmation can be cancelled and ended history can be removed directly', async t => {
  const { execute, ui, sessions } = await fixture(t);
  sessions.items.push({ id: 'active', name: 'Active' }, { id: 'ended', endedAt: 1 });
  await execute('herdr.deleteSession', 'active');
  assert.equal(ui.removals.length, 0);
  ui.response = 'Session löschen';
  await execute('herdr.deleteSession', 'active');
  assert.deepEqual(ui.removals, ['active']);
  await execute('herdr.deleteSession', 'ended');
  assert.deepEqual(ui.removals, ['active', 'ended']);
  assert.equal(ui.warnings.length, 2);
});
