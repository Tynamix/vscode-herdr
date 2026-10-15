'use strict';

const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { quoteShell } = require('../src/cli-discovery');

async function until(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + description);
}

async function run() {
  const directory = process.env.HERDR_CONTEXT_RUN;
  const file = path.join(directory, 'state.json');
  const state = JSON.parse(await fs.readFile(file));
  const save = () => fs.writeFile(file, JSON.stringify(state));
  let api;
  try {
    api = await vscode.extensions.getExtension('herdr-workbench.vscode-herdr').activate();
    async function root(expected) {
      await until(() => vscode.workspace.workspaceFolders?.length === 1 && vscode.workspace.workspaceFolders[0].uri.fsPath === expected
        && api.getSnapshot().selectedWorktree === expected && api.getSnapshot().changes.worktreePath === expected, 'single active workspace folder ' + expected);
      assert.equal(api.getSnapshot().projects.length, 2, 'Both projects remain in Herdr');
      const matches = await vscode.workspace.findFiles('**/sentinel.txt');
      assert.deepEqual(matches.map(uri => uri.fsPath), [path.join(expected, 'sentinel.txt')]);
      if (vscode.workspace.workspaceFile) assert.equal(vscode.workspace.getConfiguration('terminal.integrated').get('cwd'), expected);
      const tasks = (await vscode.tasks.fetchTasks()).filter(task => task.name.startsWith('Context '));
      assert.ok(tasks.every(task => task.scope?.uri.fsPath === expected), 'Tasks belong only to the active worktree');
      const gitApi = (await vscode.extensions.getExtension('vscode.git').activate()).getAPI(1);
      await until(() => gitApi.repositories.length === 1 && gitApi.repositories[0].rootUri.fsPath === expected, 'single native Git provider');
      return gitApi.repositories[0];
    }
    async function probeTerminal(command, expected) {
      const before = new Set(vscode.window.terminals);
      await vscode.commands.executeCommand(command);
      const terminal = await until(() => vscode.window.terminals.find(t => !before.has(t)), 'native terminal without folder picker');
      const marker = path.join(directory, `cwd-${state.phase}-${Date.now()}`);
      terminal.sendText('pwd > ' + quoteShell(marker), true);
      const cwd = await until(async () => { try { return (await fs.readFile(marker, 'utf8')).trim(); } catch { return false; } }, 'native terminal pwd');
      assert.equal(cwd, await fs.realpath(expected));
      return terminal;
    }
    const session = () => api.getSnapshot().sessions.find(item => item.id === state.sessionId);
    async function change(target, phase, command = 'herdr.selectWorktree', argument) {
      state.phase = phase;
      await save();
      await vscode.commands.executeCommand(command, argument || { worktreePath: target });
      return false;
    }
    switch (state.phase) {
      case 0:
        await vscode.commands.executeCommand('herdr.addProject', vscode.Uri.file(state.web));
        await vscode.commands.executeCommand('herdr.addProject', vscode.Uri.file(state.timi));
        return await change(state.web, 1);
      case 1: {
        await root(state.web);
        await probeTerminal('workbench.action.terminal.new', state.web); // Keep this older shell alive across switches.
        const started = await vscode.commands.executeCommand('herdr.startSession', { worktreePath: state.web, profileId: 'fixture' });
        state.sessionId = started.id;
        state.backendSession = started.backendSession;
        state.checks.push('Initial context has one root; a native terminal starts there; an agent is launched once');
        return await change(state.timi, 2);
      }
      case 2: {
        await root(state.timi);
        await until(() => session()?.connected, 'agent survives project switch');
        assert.equal((await fs.readFile(path.join(state.web, '.herdr-smoke-launches'), 'utf8')).trim(), 'launch');
        // The old project's file is deliberately active, reproducing the user's
        // case where terminal creation must still use the selected worktree.
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(state.web, 'sentinel.txt')));
        const terminal = await probeTerminal('workbench.action.terminal.new', state.timi);
        terminal.dispose();
        await until(() => !vscode.window.terminals.includes(terminal), 'test terminal closed');
        const old = vscode.window.terminals.find(t => !t.name.startsWith('Herdr'));
        assert.ok(old, 'Existing shell survives root replacement');
        old.show();
        const split = await probeTerminal('workbench.action.terminal.split', state.timi);
        split.dispose();
        state.checks.push('Switching web → timi scopes Explorer/search/Git and native new/split terminals to timi, even with an old file or shell active; catalog and agent survive');
        return await change(state.web, 3, 'herdr.focusSession', state.sessionId);
      }
      case 3: {
        const repo = await root(state.web);
        await until(() => session()?.terminalAttached, 'pending session focus resumes after extension restart');
        assert.equal((await fs.readFile(path.join(state.web, '.herdr-smoke-launches'), 'utf8')).trim(), 'launch');
        repo.inputBox.value = 'Web commit draft';
        state.checks.push('Opening a session switches back to its worktree and reconnects the same process');
        return await change(state.timi, 4);
      }
      case 4: {
        const repo = await root(state.timi);
        repo.inputBox.value = 'Timi commit draft';
        return await change(state.feature, 5, 'herdr.addToWorkspace');
      }
      case 5: {
        const repo = await root(state.feature);
        assert.notEqual(repo.inputBox.value, 'Web commit draft', 'Linked worktree has its own commit draft');
        state.checks.push('In Explorer switches to a linked worktree without accumulating old folders');
        return await change(state.web, 6);
      }
      case 6: {
        const repo = await root(state.web);
        assert.equal(repo.inputBox.value, 'Web commit draft');
        return await change(state.timi, 7);
      }
      case 7: {
        const repo = await root(state.timi);
        assert.equal(repo.inputBox.value, 'Timi commit draft');
        await vscode.commands.executeCommand('herdr.stopSession', state.sessionId);
        await vscode.commands.executeCommand('herdr.forgetSession', state.sessionId);
        state.checks.push('Commit drafts survive extension restarts independently for both projects; session cleanup succeeds');
        state.phase = 99;
        await save();
        return true;
      }
      case 99: return true;
      default: throw new Error('Invalid test phase');
    }
  } catch (error) {
    state.error = error.stack || String(error);
    state.snapshot = api?.getSnapshot();
    await save();
    throw error;
  }
}

module.exports = { run };
