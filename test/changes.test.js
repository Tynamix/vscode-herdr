'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Changes } = require('../src/changes');

function fixture() {
  const data = {};
  const calls = [];
  const uri = file => ({ fsPath: file, toString: () => 'file://' + file });
  const context = { subscriptions: [], workspaceState: {
    get: (key, fallback) => data[key] ?? fallback,
    async update(key, value) { calls.push(['save', key]); data[key] = structuredClone(value); }
  } };
  function repository(root) {
    return { rootUri: uri(root), inputBox: { value: '' },
      async status() { calls.push(['status', root]); },
      state: { onDidChange() {
        calls.push(['listen', root]);
        return { dispose() { calls.push(['unlisten', root]); } };
      } } };
  }
  const api = {
    repositories: [],
    onDidOpenRepository: () => ({ dispose() {} }),
    async openRepository(root) {
      calls.push(['open', root.fsPath]);
      const selected = repository(root.fsPath);
      api.repositories.push(selected);
      return selected;
    }
  };
  const vscode = {
    Uri: { file: uri },
    EventEmitter: class { event() {} fire() { calls.push(['changed']); } dispose() {} },
    workspace: { isTrusted: true, registerTextDocumentContentProvider: () => ({ dispose() {} }) },
    window: { createTreeView: () => ({ dispose() {} }) },
    extensions: { getExtension: () => ({ activate: async () => ({ enabled: true, getAPI: () => api }) }) },
    commands: { async executeCommand(command, root) {
      assert.equal(command, 'git.close');
      calls.push(['close', root.fsPath]);
      api.repositories = api.repositories.filter(repository => repository.rootUri.fsPath !== root.fsPath);
    } }
  };
  const changes = new Changes(vscode, context);
  return { changes, data, calls, context, vscode, api, repository };
}

test('untrusted workspaces report the trust requirement before looking for Git', async () => {
  const changes = Object.create(Changes.prototype);
  changes.generation = 1;
  changes.vscode = {
    workspace: { isTrusted: false },
    extensions: { getExtension() { assert.fail('Git must not be accessed in an untrusted workspace'); } }
  };
  await assert.rejects(changes.applySelection({ path: '/project' }, 1), /Manage Workspace Trust/);
});

test('trusted workspaces still report a missing built-in Git extension', async () => {
  const changes = Object.create(Changes.prototype);
  changes.generation = 1;
  changes.vscode = {
    workspace: { isTrusted: true },
    extensions: { getExtension: () => undefined }
  };
  await assert.rejects(changes.applySelection({ path: '/project' }, 1), /Git extension is unavailable/);
});

test('selecting the same checkout keeps its provider, listener and visible changes while refreshing status', async () => {
  const { changes, calls } = fixture();
  const first = await changes.select({ path: '/project', branch: 'main' });
  calls.length = 0;
  const pending = changes.select({ path: '/project', branch: 'renamed' });
  assert.equal(changes.repository, first, 'The changes view must not be cleared during a same-worktree switch');
  assert.equal(calls.length, 0);
  assert.equal(await pending, first);
  assert.deepEqual(calls.filter(call => ['open', 'close', 'listen', 'unlisten'].includes(call[0])), []);
  assert.deepEqual(calls.filter(call => call[0] === 'status'), [['status', '/project']]);
  assert.equal(changes.tree.description, 'renamed');
});

test('a provider closed externally is reopened instead of reusing a stale reference', async () => {
  const { changes, api, calls } = fixture();
  const first = await changes.select({ path: '/project' });
  api.repositories = [];
  calls.length = 0;
  const second = await changes.select({ path: '/project' });
  assert.notEqual(second, first);
  assert.equal(changes.repository, second);
  assert.deepEqual(calls.filter(call => call[0] === 'open'), [['open', '/project']]);
});

test('existing providers are reused only after other repositories have been closed and drafts saved', async () => {
  const { changes, api, repository, calls, data } = fixture();
  const main = repository('/main');
  const linked = repository('/linked');
  main.inputBox.value = 'Main draft';
  linked.inputBox.value = 'Linked draft';
  api.repositories.push(main, linked);
  await changes.select({ path: '/linked' });
  assert.equal(changes.repository, linked);
  assert.deepEqual(calls.filter(call => ['save', 'close', 'open'].includes(call[0])),
    [['save', 'gitCommitDrafts'], ['close', '/main']]);
  assert.deepEqual(data.gitCommitDrafts, [['file:///main', 'Main draft'], ['file:///linked', 'Linked draft']]);
});

test('closing a main repository may dispose its linked provider, which must then be reopened with its draft', async () => {
  const { changes, api, repository, vscode } = fixture();
  const main = repository('/main');
  const linked = repository('/linked');
  linked.inputBox.value = 'Linked draft';
  api.repositories.push(main, linked);
  vscode.commands.executeCommand = async () => { api.repositories = []; };
  const selected = await changes.select({ path: '/linked' });
  assert.notEqual(selected, linked);
  assert.equal(selected.inputBox.value, 'Linked draft');
});

test('unchanged commit drafts do not cause storage writes, but edits and cleared drafts are persisted', async () => {
  const { changes, calls, data } = fixture();
  await changes.saveDrafts();
  assert.equal(calls.filter(call => call[0] === 'save').length, 0);
  const selected = await changes.select({ path: '/project' });
  selected.inputBox.value = 'Draft';
  await changes.saveDrafts();
  await changes.saveDrafts();
  assert.equal(calls.filter(call => call[0] === 'save').length, 1);
  selected.inputBox.value = '';
  await changes.saveDrafts();
  assert.equal(calls.filter(call => call[0] === 'save').length, 2);
  assert.deepEqual(data.gitCommitDrafts, [['file:///project', '']]);
});

test('a failed draft write is surfaced and retried even when the draft has not changed', async () => {
  const { changes, context, data } = fixture();
  const selected = await changes.select({ path: '/project' });
  selected.inputBox.value = 'Unsaved draft';
  const update = context.workspaceState.update;
  context.workspaceState.update = async (key, value) => {
    data[key] = structuredClone(value);
    throw new Error('Storage unavailable');
  };
  await assert.rejects(changes.saveDrafts(), /Storage unavailable/);
  let retries = 0;
  context.workspaceState.update = async (...args) => { retries++; await update(...args); };
  await changes.saveDrafts();
  assert.equal(retries, 1);
  assert.deepEqual(data.gitCommitDrafts, [['file:///project', 'Unsaved draft']]);
});
