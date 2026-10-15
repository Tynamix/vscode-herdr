'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const manifest = require('../package.json');

async function until(predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Documentation scene did not become ready.');
}

async function activate() {
  const directory = process.env.HERDR_SCREENSHOTS_RUN;
  const dataFile = path.join(directory, 'state.json');
  const state = JSON.parse(await fs.readFile(dataFile));
  const save = () => fs.writeFile(dataFile, JSON.stringify(state, null, 2) + '\n');
  const api = await vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`).activate();
  const command = (name, input) => vscode.commands.executeCommand(name, input);
  try {
    await command('workbench.action.closeAllEditors');
    await command('herdr.addProject', vscode.Uri.file(state.web));
    await command('herdr.addProject', vscode.Uri.file(state.api));
    state.sessions = {};
    for (const [task, worktreePath, profileId, transition] of [
      ['checkout', state.checkout, 'demo-checkout', 'work'],
      ['accessibility', state.accessibility, 'demo-accessibility', 'done'],
      ['orders', state.orders, 'demo-orders', 'block']
    ]) {
      const session = await command('herdr.startSession', { worktreePath, profileId });
      state.backendSession = session.backendSession;
      state.sessions[task] = session.id;
      await save();
      const terminal = vscode.window.terminals.find(item => item.name === session.terminalName);
      await until(() => api.getSnapshot().sessions.find(item => item.id === session.id)?.indicator.state === 'idle');
      if (transition === 'done') {
        terminal.sendText('work');
        await until(() => api.getSnapshot().sessions.find(item => item.id === session.id)?.indicator.state === 'working');
      }
      terminal.sendText(transition);
      await until(() => api.getSnapshot().sessions.find(item => item.id === session.id)?.indicator.state
        === ({ work: 'working', done: 'done', block: 'blocked' })[transition]);
    }
    await command('herdr.selectWorktree', { worktreePath: state.checkout });
    await command('workbench.view.extension.herdr');
    await command('workbench.action.closePanel');
    await command('herdr.overview');
    await command('notifications.clearAll');
    state.ready = true;
    state.scene = 'overview';
    await save();

    let lastRequest;
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const request = JSON.parse(await fs.readFile(path.join(directory, 'scene.json')));
        if (request.request === lastRequest) return;
        lastRequest = request.request;
        if (request.scene === 'overview') {
          await command('workbench.action.closePanel');
          await command('workbench.view.extension.herdr');
          await command('herdr.overview');
        } else if (request.scene === 'diff') {
          await command('workbench.action.closePanel');
          await command('herdr.selectWorktree', { worktreePath: state.checkout });
          const extension = await vscode.extensions.getExtension('vscode.git').activate();
          const repo = extension.getAPI(1).repositories.find(item => item.rootUri.fsPath === state.checkout);
          await repo.status();
          await command('herdr.openChange', { change: repo.state.workingTreeChanges[0], staged: false });
        } else if (request.scene === 'terminal') {
          await command('workbench.action.closeAllEditors');
          await vscode.window.showTextDocument(vscode.Uri.file(path.join(state.checkout, 'src/checkout.ts')), { preview: false });
          await command('herdr.focusSession', state.sessions.checkout);
        } else if (request.scene === 'background') {
          const session = api.getSnapshot().sessions.find(item => item.id === state.sessions.checkout);
          vscode.window.terminals.find(item => item.name === session.terminalName)?.dispose();
          await until(() => !api.getSnapshot().sessions.find(item => item.id === session.id)?.terminalAttached);
          await command('workbench.action.closePanel');
          await command('herdr.overview');
        } else if (request.scene === 'stop') {
          for (const id of Object.values(state.sessions)) {
            await command('herdr.stopSession', id);
            await command('herdr.deleteSession', id);
          }
          state.scene = 'stopped';
          await save();
          await command('workbench.action.closeWindow');
          return;
        }
        state.scene = request.scene;
        await command('notifications.clearAll');
        delete state.error;
        state.snapshot = api.getSnapshot();
        await save();
      } catch (error) { state.error = error.stack || String(error); await save(); }
      finally { busy = false; }
    }, 400);
  } catch (error) { state.error = error.stack || String(error); await save(); throw error; }
}

module.exports = { activate };
