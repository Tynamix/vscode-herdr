'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Sessions } = require('../src/sessions');
const { profiles, agentIndicator, restoreSessions, sortSessions } = require('../src/model');

function event() {
  const listeners = new Set();
  return { subscribe(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    fire(value) { for (const callback of listeners) callback(value); } };
}

function fixture(t, { saved = [], terminals = [], snapshot } = {}) {
  const events = Object.fromEntries(['open', 'close', 'active'].map(key => [key, event()]));
  const calls = [];
  const data = { sessions: saved, herdrBackendSession: 'vscode-test' };
  const state = snapshot || { workspaces: [], panes: [], agents: [] };
  const backend = {
    async ensure() { calls.push(['ensure']); },
    async create(cwd, label) {
      const n = state.workspaces.length + 1;
      const workspace = { workspace_id: `w${n}`, label };
      const root_pane = { pane_id: `p${n}`, terminal_id: `t${n}`, workspace_id: workspace.workspace_id, agent_status: 'idle' };
      state.workspaces.push(workspace); state.panes.push(root_pane);
      calls.push(['create', cwd]);
      return { workspace, root_pane };
    },
    async run(...args) { calls.push(['run', ...args]); },
    async snapshot() { return backend.offline ? undefined : structuredClone(state); },
    subscribe(_ids, onEvent) { backend.onEvent = onEvent; return { dispose() {} }; },
    async focus(id) { calls.push(['focus', id]); },
    async interrupt(id) { calls.push(['interrupt', id]); },
    async stop(id) { calls.push(['stop', id]); state.workspaces = state.workspaces.filter(w => w.workspace_id !== id); }
  };
  const context = { subscriptions: [], extensionUri: { fsPath: '/extension dir' },
    workspaceState: { get: (key, fallback) => data[key] ?? fallback, update: async (key, value) => { data[key] = structuredClone(value); } } };
  const vscode = {
    ThemeIcon: class {}, TerminalLocation: { Panel: 1, Editor: 2 },
    commands: { async executeCommand(...args) { calls.push(['command', ...args]); } },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: (key, fallback) => key === 'terminalLocation' ? 'panel' : key === 'autoArrangeSessions' ? false : fallback }) },
    window: { terminals,
      onDidOpenTerminal: events.open.subscribe, onDidCloseTerminal: events.close.subscribe, onDidChangeActiveTerminal: events.active.subscribe,
      createTerminal(options) {
        const terminal = { creationOptions: options, name: options.name,
          show() { vscode.window.activeTerminal = terminal; events.active.fire(terminal); },
          dispose() { terminals.splice(terminals.indexOf(terminal), 1); options.pty?.close(); events.close.fire(terminal); } };
        terminals.push(terminal); events.open.fire(terminal);
        return terminal;
      }
    }
  };
  const errors = [];
  const manager = new Sessions(vscode, context, () => {}, error => errors.push(error), { backend,
    makeController: () => ({ ready: Promise.resolve(), close() {}, dispose() {}, scroll(direction) { calls.push(['scroll', direction]); } }) });
  t.after(() => { for (const disposable of context.subscriptions) disposable.dispose(); });
  return { manager, vscode, events, calls, errors, data, state, backend };
}

const tree = { path: '/project/worktree', branch: 'feature/test' };
const project = { id: '/project/.git', name: 'project' };
const profile = { id: 'pi', kind: 'pi', name: 'Pi', command: "'/bin/pi' --offline" };

test('starts exactly once in the selected worktree and injects the Pi integration only for that process', async t => {
  const { manager, calls } = fixture(t);
  const session = await manager.start(tree, project, profile);
  assert.deepEqual(calls.filter(c => c[0] === 'create'), [['create', tree.path]]);
  assert.equal(calls.filter(c => c[0] === 'run').length, 1);
  assert.match(calls.find(c => c[0] === 'run')[2], /^'\/bin\/pi' --extension '\/extension dir\/integrations\/pi-status.mjs' --offline$/);
  assert.equal(agentIndicator(manager.find(session.id)).state, 'idle');
  await manager.focus(session.id);
  await manager.focus(session.id);
  assert.equal(calls.filter(c => c[0] === 'run').length, 1);
});

test('working, nested approval, unread completion and seen completion have distinct indicators', async t => {
  const { manager, state } = fixture(t);
  const { id } = await manager.start(tree, project, profile);
  const pane = state.panes[0];
  const agent = { pane_id: pane.pane_id, agent_status: 'working', state_change_seq: 1 };
  state.agents.push(agent);
  await manager.refresh();
  assert.equal(agentIndicator(manager.find(id)).icon, 'loading~spin');
  agent.agent_status = 'blocked'; agent.state_change_seq++;
  await manager.refresh();
  assert.equal(agentIndicator(manager.find(id)).color, 'charts.yellow');
  await manager.focus(id);
  assert.equal(agentIndicator(manager.find(id)).state, 'blocked');
  agent.agent_status = 'done'; agent.state_change_seq++;
  await manager.refresh();
  assert.equal(agentIndicator(manager.find(id)).color, 'charts.blue');
  manager.markSeen(id);
  await manager.refresh();
  assert.equal(agentIndicator(manager.find(id)).state, 'idle');
  agent.agent_status = 'working'; agent.state_change_seq++;
  await manager.refresh();
  agent.agent_status = 'done'; agent.state_change_seq++;
  await manager.refresh();
  assert.equal(agentIndicator(manager.find(id)).state, 'done');
});

test('closing and reopening the terminal detaches the renderer and never restarts or stops the agent', async t => {
  const { manager, calls } = fixture(t);
  const { id } = await manager.start(tree, project, profile);
  manager.live.get(id).terminal.dispose();
  assert.equal(manager.live.has(id), false);
  assert.equal(manager.find(id).backendAlive, true);
  await assert.rejects(manager.forget(id), /Stop the session first/);
  await manager.focus(id);
  assert.equal(manager.live.has(id), true);
  assert.equal(calls.filter(c => c[0] === 'run').length, 1);
  assert.equal(calls.filter(c => c[0] === 'stop').length, 0);
  await manager.interrupt(id);
  assert.deepEqual(calls.at(-1), ['interrupt', manager.find(id).paneId]);
});

test('reload reconnects persisted daemon metadata without replaying the launch command', async t => {
  const first = fixture(t);
  const { id } = await first.manager.start(tree, project, profile);
  const saved = structuredClone(first.data.sessions);
  first.manager.dispose();
  const second = fixture(t, { saved, snapshot: first.state });
  await second.manager.ready;
  await second.manager.refresh();
  assert.equal(second.manager.find(id).backendAlive, true);
  await second.manager.focus(id);
  assert.ok(second.manager.live.has(id));
  assert.equal(second.calls.filter(c => ['create', 'run', 'stop'].includes(c[0])).length, 0);
});

test('an idle transition after observed work stays blue until acknowledged, including across reload', async t => {
  const first = fixture(t);
  const { id } = await first.manager.start(tree, project, profile);
  const pane = first.state.panes[0];
  first.state.agents.push({ pane_id: pane.pane_id, agent_status: 'working', state_change_seq: 2 });
  await first.manager.refresh();
  const saved = structuredClone(first.data.sessions);
  first.manager.dispose();
  first.state.agents[0].agent_status = 'idle';
  first.state.agents[0].state_change_seq = 3;
  const second = fixture(t, { saved, snapshot: first.state });
  await second.manager.ready;
  await second.manager.refresh();
  assert.equal(agentIndicator(second.manager.find(id)).state, 'done');
  await second.manager.refresh();
  assert.equal(agentIndicator(second.manager.find(id)).state, 'done');
  second.manager.markSeen(id);
  await second.manager.refresh();
  assert.equal(agentIndicator(second.manager.find(id)).state, 'idle');
});

test('an initial idle dialog and a replaced terminal do not invent completed work', async t => {
  const { manager, state } = fixture(t);
  const { id } = await manager.start(tree, project, profile);
  const pane = state.panes[0];
  const agent = { pane_id: pane.pane_id, agent_status: 'blocked', state_change_seq: 1 };
  state.agents.push(agent);
  await manager.refresh();
  agent.agent_status = 'idle'; agent.state_change_seq++;
  await manager.refresh();
  assert.equal(agentIndicator(manager.find(id)).state, 'idle');
  agent.agent_status = 'working'; agent.state_change_seq++;
  await manager.refresh();
  pane.terminal_id = 'replacement-terminal';
  agent.agent_status = 'idle'; agent.state_change_seq++;
  await manager.refresh();
  assert.equal(agentIndicator(manager.find(id)).state, 'idle');
});

test('a short turn observed through events is not lost between idle snapshots', async t => {
  const { manager, backend, state } = fixture(t);
  const { id } = await manager.start(tree, project, profile);
  const pane = state.panes[0];
  backend.onEvent({ event: 'pane.agent_status_changed', data: { pane_id: pane.pane_id, workspace_id: pane.workspace_id, agent_status: 'working' } });
  state.agents.push({ pane_id: pane.pane_id, agent_status: 'idle', state_change_seq: 3 });
  await manager.refresh();
  assert.equal(agentIndicator(manager.find(id)).state, 'done');
});

test('stop closes only the owned session and leaves a second session running', async t => {
  const { manager, calls } = fixture(t);
  const first = await manager.start(tree, project, profile);
  const second = await manager.start(tree, project, profile);
  await manager.stop(first.id);
  await manager.forget(first.id);
  assert.equal(manager.find(first.id), undefined);
  assert.equal(manager.find(second.id).backendAlive, true);
  assert.deepEqual(calls.filter(c => c[0] === 'stop'), [['stop', first.workspaceId]]);
});

test('delete stops and forgets only the selected session, including a background session', async t => {
  const { manager, calls, data } = fixture(t);
  const first = await manager.start(tree, project, profile);
  const second = await manager.start(tree, project, profile);
  manager.live.get(first.id).terminal.dispose();
  await manager.remove(first.id);
  assert.equal(manager.find(first.id), undefined);
  assert.equal(data.sessions.some(session => session.id === first.id), false);
  assert.equal(manager.find(second.id).backendAlive, true);
  assert.equal(manager.live.has(second.id), true);
  assert.deepEqual(calls.filter(c => c[0] === 'stop'), [['stop', first.workspaceId]]);
  const terminal = manager.live.get(second.id).terminal;
  await manager.remove(second.id);
  assert.equal(manager.find(second.id), undefined);
  assert.equal(manager.live.has(second.id), false);
  assert.equal(manager.vscode.window.terminals.includes(terminal), false);
});

test('delete retains the entry and its terminal when stopping the agent fails or the backend is offline', async t => {
  const { manager, backend } = fixture(t);
  const { id } = await manager.start(tree, project, profile);
  backend.stop = async () => { throw new Error('Stop failed'); };
  await assert.rejects(manager.remove(id), /Stop failed/);
  assert.equal(manager.find(id).backendAlive, true);
  assert.equal(manager.live.has(id), true);
  backend.offline = true;
  await assert.rejects(manager.remove(id), /unreachable/);
  assert.ok(manager.find(id));
  assert.equal(manager.live.has(id), true);
});

test('delete cleans up ended history and stale renderers without touching a foreign workspace', async t => {
  const { manager, state, calls, backend } = fixture(t);
  const { id } = await manager.start(tree, project, profile);
  state.workspaces[0].label = 'Foreign workspace';
  await manager.remove(id);
  assert.equal(manager.find(id), undefined);
  assert.equal(manager.live.has(id), false);
  assert.equal(calls.filter(call => call[0] === 'stop').length, 0);
  assert.equal(state.workspaces.length, 1);
  backend.offline = true;
  await manager.remove(id); // Repeated deletion of an already removed entry is harmless.
});

test('definitively stopped history stays removable if the daemon later goes offline', async t => {
  const { manager, backend } = fixture(t);
  const { id } = await manager.start(tree, project, profile);
  await manager.stop(id);
  backend.offline = true;
  await manager.refresh();
  assert.equal(manager.find(id).status, 'closed');
  await manager.forget(id);
  assert.equal(manager.find(id), undefined);
});

test('stop completes even when VS Code delivers the terminal-close event later', async t => {
  const { manager } = fixture(t);
  const { id } = await manager.start(tree, project, profile);
  manager.live.get(id).terminal.dispose = () => {};
  await manager.stop(id);
  assert.equal(manager.live.has(id), false);
  await manager.forget(id);
  assert.equal(manager.find(id), undefined);
});

test('offline backend does not invent completion or permit removing a potentially running session', async t => {
  const { manager, backend, calls } = fixture(t);
  const { id } = await manager.start(tree, project, profile);
  backend.offline = true;
  manager.live.get(id).terminal.dispose();
  await manager.refresh();
  assert.equal(manager.find(id).status, 'detached');
  assert.equal(manager.find(id).unreadCompletion, false);
  await assert.rejects(manager.forget(id), /unreachable/);
  assert.equal(calls.filter(c => c[0] === 'stop').length, 0);
});

test('ownership mismatch prevents closing a different daemon workspace', async t => {
  const { manager, state, calls } = fixture(t);
  const { id } = await manager.start(tree, project, profile);
  state.workspaces[0].label = 'Foreign workspace';
  await assert.rejects(manager.stop(id), /not connected to herdr/);
  assert.equal(calls.filter(c => c[0] === 'stop').length, 0);
});

test('an unconfirmed launch is retained for inspection and never submitted again', async t => {
  const { manager, backend, calls } = fixture(t);
  backend.run = async () => { calls.push(['run']); throw new Error('timeout'); };
  await assert.rejects(manager.start(tree, project, profile), /existing session/);
  assert.equal(manager.items.length, 1);
  await manager.focus(manager.items[0].id);
  assert.equal(calls.filter(c => c[0] === 'run').length, 1);
});

test('legacy direct terminals remain attached without relaunching them', t => {
  const saved = [{ id: 'old', terminalName: 'Herdr old', status: 'running', attention: 'input' }];
  const terminal = { name: 'Herdr old', creationOptions: { env: { HERDR_WORKBENCH_SESSION: 'old' } } };
  const { manager, calls } = fixture(t, { saved, terminals: [terminal] });
  assert.equal(manager.find('old').status, 'unknown');
  assert.equal(manager.find('old').attention, 'input');
  assert.equal(manager.live.has('old'), true);
  assert.deepEqual(calls.filter(call => call[0] !== 'command'), []);
  assert.equal(restoreSessions([{ status: 'running' }])[0].status, 'detached');
});

test('profiles reject invalid IDs, duplicate IDs and multiline commands', () => {
  assert.throws(() => profiles([{ name: 'Missing id', command: 'pi' }]));
  assert.throws(() => profiles([profile, profile]), /Duplicate/);
  assert.throws(() => profiles([{ ...profile, command: 'pi\nother' }]));
  assert.deepEqual(profiles([profile]), [profile]);
  assert.deepEqual(sortSessions([{ id: 1, agentState: 'idle', createdAt: 100 },
    { id: 2, agentState: 'blocked', createdAt: 1 }]).map(item => item.id), [2, 1]);
});

test('untrusted workspaces cannot start a server or CLI', async t => {
  const { manager, vscode, calls } = fixture(t);
  vscode.workspace.isTrusted = false;
  await assert.rejects(manager.start(tree, project, profile), /trusted/);
  assert.deepEqual(calls.filter(call => call[0] !== 'command'), []);
});

test('page scrolling and its keybinding context follow only the active managed terminal', async t => {
  const { manager, vscode, calls } = fixture(t);
  const { id } = await manager.start(tree, project, profile);
  assert.deepEqual(calls.findLast(call => call[1] === 'setContext'), ['command', 'setContext', 'herdr.sessionTerminalActive', true]);
  manager.scroll('up');
  assert.deepEqual(calls.at(-1), ['scroll', 'up']);
  manager.live.get(id).terminal.dispose();
  manager.scroll('down');
  assert.deepEqual(calls.findLast(call => call[1] === 'setContext'), ['command', 'setContext', 'herdr.sessionTerminalActive', false]);
  vscode.window.activeTerminal = {};
  manager.scroll('down');
  assert.equal(calls.filter(call => call[0] === 'scroll').length, 1);
});
