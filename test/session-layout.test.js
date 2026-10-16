'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { showSession } = require('../src/session-layout');

function fixture({ location = 'panel', enabled = true, visible = true, maximized = false } = {}) {
  const settings = { 'herdr.terminalLocation': location, 'herdr.autoArrangeSessions': enabled };
  const state = { visible, maximized, position: 'right', alignment: 'justify', focused: false };
  const calls = [];
  const vscode = {
    ConfigurationTarget: { Workspace: 2 },
    workspace: { workspaceFolders: [{}], getConfiguration: section => ({
      get: (key, fallback) => settings[`${section}.${key}`] ?? fallback,
      async update(key, value, target) { assert.equal(target, 2); settings[`${section}.${key}`] = value; }
    }) },
    commands: { async executeCommand(command) {
      calls.push(command);
      if (command.endsWith('positionPanelBottom')) state.position = 'bottom';
      if (command.endsWith('alignPanelCenter')) state.alignment = 'center';
      if (command.endsWith('closePanel')) state.visible = false;
      if (command.endsWith('toggleMaximizedPanel')) {
        state.maximized = state.visible ? !state.maximized : true;
        state.visible = true;
      }
    } }
  };
  const terminal = { show() { state.focused = true; } };
  return { vscode, terminal, state, settings, calls };
}

test('session layout always opens a maximized bottom panel, including repeated focus', async () => {
  for (const visible of [false, true]) for (const maximized of [false, true]) {
    const { vscode, terminal, state, settings } = fixture({ visible, maximized });
    for (let i = 0; i < 2; i++) {
      await showSession(vscode, terminal);
      assert.deepEqual(state, { visible: true, maximized: true, position: 'bottom', alignment: 'center', focused: true });
      assert.equal(settings['workbench.sideBar.location'], 'left');
      assert.equal(settings['terminal.integrated.tabs.enabled'], true);
      assert.equal(settings['terminal.integrated.tabs.location'], 'right');
      assert.equal(settings['terminal.integrated.tabs.hideCondition'], 'never');
    }
  }
});

test('concurrent session opens serialize the maximize commands and retain the last focus', async () => {
  const { vscode, state, terminal } = fixture();
  let focus;
  await Promise.all([showSession(vscode, { show() { focus = 'first'; } }),
    showSession(vscode, { show() { terminal.show(); focus = 'last'; } })]);
  assert.equal(state.maximized, true);
  assert.equal(focus, 'last');
});

test('an empty window never tries to save workspace preferences globally', async () => {
  const { vscode, terminal, settings } = fixture();
  vscode.workspace.workspaceFolders = [];
  const before = { ...settings };
  await showSession(vscode, terminal);
  assert.deepEqual(settings, before);
});

test('editor terminals and opting out preserve the existing layout and settings', async () => {
  for (const options of [{ location: 'editor' }, { enabled: false }]) {
    const { vscode, terminal, state, settings, calls } = fixture(options);
    const before = { ...settings };
    await showSession(vscode, terminal);
    assert.deepEqual(calls, []);
    assert.deepEqual(settings, before);
    assert.equal(state.position, 'right');
    assert.equal(state.maximized, false);
    assert.equal(state.focused, true);
  }
});
