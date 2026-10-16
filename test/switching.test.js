'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function fixture(t, saved = {}) {
  const main = { path: '/project/main', branch: 'main', isMain: true };
  const feature = { path: '/project/feature', branch: 'feature', isMain: false };
  const other = { path: '/other/main', branch: 'main', isMain: true };
  const inventory = new Map([[main.path, [main, feature]], [other.path, [other]]]);
  const data = { projects: [{ id: 'project', name: 'Project', path: main.path },
    { id: 'other', name: 'Other', path: other.path }], ...saved };
  const calls = [];
  const updates = [];
  const commands = new Map();
  const events = {};
  const ui = { switchResult: false, statusError: undefined };
  const disposable = () => ({ dispose() {} });
  const git = {
    async listWorktrees(root) {
      calls.push(['list', root]);
      return inventory.get(root).map(tree => ({ ...tree }));
    },
    async worktreeStatus(tree) {
      calls.push(['status', tree.path]);
      await ui.beforeStatus?.(tree);
      return { ...tree, ...(tree.prunable || ui.statusError
        ? { error: ui.statusError || 'Worktree no longer exists on the filesystem.' } : { changedFiles: 1 }) };
    }
  };
  let sessions;
  class MemorySessions {
    constructor() {
      sessions = this;
      this.items = [{ id: 'one', worktreePath: main.path }, { id: 'two', worktreePath: feature.path }];
      this.live = new Map();
    }
    find(id) { return this.items.find(session => session.id === id); }
    async refresh() { calls.push(['sessions-refresh']); }
    async focus(id) { calls.push(['focus', id]); }
  }
  class MemoryChanges {
    async saveDrafts() { calls.push(['drafts']); }
    async select(worktree) {
      calls.push(['changes', worktree.path]);
      this.repository = { rootUri: { fsPath: worktree.path } };
      return true;
    }
    getChildren() { return []; }
  }
  class MemoryWorktreeContext {
    static async restore() {}
    enabled() { return true; }
    async switch(resolved) {
      calls.push(['switch', resolved.worktree.path, structuredClone(data.worktreeContextAction)]);
      assert.equal(data.selectedWorktree, resolved.worktree.path);
      return ui.switchResult;
    }
  }
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    EventEmitter: class { event() {} fire() {} dispose() {} },
    TreeItem: class {}, TreeItemCollapsibleState: { Expanded: 2 }, ThemeIcon: class {}, ThemeColor: class {},
    workspace: {
      getConfiguration: () => ({ get: (_name, fallback) => fallback }),
      onDidSaveTextDocument: disposable,
      onDidChangeWorkspaceFolders(callback) { events.folders = callback; return disposable(); },
      onDidChangeConfiguration: disposable
    },
    commands: {
      registerCommand(name, handler) { commands.set(name, handler); return disposable(); },
      async executeCommand(name, ...args) { calls.push(['command', name]); return commands.get(name)?.(...args); }
    },
    window: {
      createOutputChannel: () => ({ ...disposable(), appendLine(message) { calls.push(['log', message]); } }),
      createStatusBarItem: () => ({ ...disposable(), show() {} }),
      createTreeView: disposable, onDidChangeWindowState: disposable,
      showErrorMessage(message) { calls.push(['error', message]); }
    }
  };
  const context = { subscriptions: [], workspaceState: {
    get: (key, fallback) => data[key] ?? fallback,
    async update(key, value) {
      updates.push([key, structuredClone(value)]);
      if (value === undefined) delete data[key];
      else data[key] = structuredClone(value);
    }
  } };
  const filename = path.join(__dirname, '../src/extension.js');
  const actualRequire = createRequire(filename);
  const overrides = { vscode, './git': git, './sessions': { Sessions: MemorySessions },
    './changes': { Changes: MemoryChanges }, './worktree-context': { WorktreeContext: MemoryWorktreeContext } };
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
    module, require: name => overrides[name] || actualRequire(name), setTimeout, clearTimeout, setInterval, clearInterval
  }, { filename });
  const api = await module.exports.activate(context);
  t.after(() => { for (const item of context.subscriptions) item.dispose(); });
  await api.refresh();
  await new Promise(setImmediate);
  return { main, feature, other, inventory, calls, updates, data, ui, api, events, sessions,
    execute: (name, input) => commands.get(name)(input) };
}

test('activation restores the selection and pending session action with only one full catalog scan', async t => {
  const { main, feature, other, calls, data } = await fixture(t, {
    selectedWorktree: '/project/main', worktreeContextAction: { type: 'session', sessionId: 'one' }
  });
  assert.deepEqual(calls.filter(call => call[0] === 'list'), [['list', main.path], ['list', other.path]]);
  assert.deepEqual(calls.filter(call => call[0] === 'status').map(call => call[1]).sort(),
    [main.path, feature.path, other.path].sort());
  assert.deepEqual(calls.filter(call => call[0] === 'focus'), [['focus', 'one']]);
  assert.equal(data.worktreeContextAction, undefined);
});

test('session switching validates only its project and checkout, not unrelated worktree statuses', async t => {
  const { main, feature, calls, execute, api } = await fixture(t);
  calls.length = 0;
  await execute('herdr.focusSession', 'two');
  assert.deepEqual(calls.filter(call => call[0] === 'list'), [['list', main.path]]);
  assert.deepEqual(calls.filter(call => call[0] === 'status'), [['status', feature.path]]);
  assert.deepEqual(calls.filter(call => call[0] === 'focus'), [['focus', 'two']]);
  assert.equal(api.getSnapshot().selectedWorktree, feature.path);
  assert.equal(api.getSnapshot().projects[0].worktrees[1].changedFiles, 1);
});

test('repeated focus still persists its selection and action without a full catalog scan', async t => {
  const { main, calls, updates, execute } = await fixture(t, { selectedWorktree: '/project/main' });
  calls.length = 0;
  updates.length = 0;
  await execute('herdr.focusSession', 'one');
  assert.deepEqual(updates.filter(([key]) => key === 'selectedWorktree'), [['selectedWorktree', main.path]]);
  assert.deepEqual(updates.find(([key]) => key === 'worktreeContextAction'),
    ['worktreeContextAction', { type: 'session', sessionId: 'one' }]);
  assert.deepEqual(calls.filter(call => call[0] === 'list'), [['list', main.path]]);
  assert.deepEqual(calls.filter(call => call[0] === 'focus'), [['focus', 'one']]);
});

test('manual refresh still scans every project and worktree', async t => {
  const { main, feature, other, calls, execute } = await fixture(t);
  calls.length = 0;
  await execute('herdr.refresh');
  assert.deepEqual(calls.filter(call => call[0] === 'list'), [['list', main.path], ['list', other.path]]);
  assert.deepEqual(calls.filter(call => call[0] === 'status').map(call => call[1]).sort(),
    [main.path, feature.path, other.path].sort());
  assert.equal(calls.filter(call => call[0] === 'sessions-refresh').length, 1);
});

test('uncached worktrees are discovered and branch metadata is refreshed before selection', async t => {
  const { main, feature, inventory, execute, api } = await fixture(t);
  inventory.get(main.path)[1] = { ...feature, branch: 'renamed-feature' };
  await execute('herdr.selectWorktree', feature.path);
  assert.equal(api.getSnapshot().projects[0].worktrees[1].branch, 'renamed-feature');
  const added = { path: '/project/new', branch: 'new', isMain: false };
  inventory.get(main.path).push(added);
  await execute('herdr.selectWorktree', added.path);
  assert.equal(api.getSnapshot().selectedWorktree, added.path);
});

test('removed, prunable and inaccessible cached worktrees cannot be selected', async t => {
  for (const failure of ['removed', 'prunable', 'inaccessible']) {
    await t.test(failure, async t => {
      const { main, feature, inventory, calls, ui, execute, api } = await fixture(t, { selectedWorktree: '/project/main' });
      if (failure === 'removed') inventory.set(main.path, [main]);
      if (failure === 'prunable') inventory.get(main.path)[1] = { ...feature, prunable: true };
      if (failure === 'inaccessible') ui.statusError = 'Permission denied';
      calls.length = 0;
      await assert.rejects(execute('herdr.focusSession', 'two'), /no longer available/);
      assert.equal(api.getSnapshot().selectedWorktree, main.path);
      assert.equal(calls.filter(call => ['drafts', 'changes', 'switch', 'focus'].includes(call[0])).length, 0);
    });
  }
});

test('a slow superseded click cannot switch the workspace or focus its session', async t => {
  const { main, feature, calls, ui, execute, api } = await fixture(t);
  let release;
  let started;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  ui.beforeStatus = tree => {
    if (tree.path === feature.path) { started(); return blocked; }
  };
  calls.length = 0;
  const first = execute('herdr.focusSession', 'two');
  await entered;
  await execute('herdr.focusSession', 'one');
  release();
  await first;
  assert.equal(api.getSnapshot().selectedWorktree, main.path);
  assert.deepEqual(calls.filter(call => call[0] === 'focus'), [['focus', 'one']]);
  assert.deepEqual(calls.filter(call => call[0] === 'switch').map(call => call[1]), [main.path]);
});

test('workspace switching preserves the pending action until folder-change restoration completes', async t => {
  const { feature, calls, data, ui, events, execute } = await fixture(t);
  calls.length = 0;
  ui.switchResult = true;
  await execute('herdr.focusSession', 'two');
  assert.deepEqual(data.worktreeContextAction, { type: 'session', sessionId: 'two' });
  assert.deepEqual(calls.find(call => call[0] === 'switch'),
    ['switch', feature.path, { type: 'session', sessionId: 'two' }]);
  assert.equal(calls.filter(call => call[0] === 'focus').length, 0);
  ui.switchResult = false;
  events.folders();
  await new Promise(setImmediate);
  assert.deepEqual(calls.filter(call => call[0] === 'focus'), [['focus', 'two']]);
  assert.equal(data.worktreeContextAction, undefined);
});
