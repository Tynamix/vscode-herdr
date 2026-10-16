'use strict';

const queues = new WeakMap();

function showSession(vscode, terminal) {
  const pending = (queues.get(vscode) || Promise.resolve()).then(() => arrangeSession(vscode, terminal));
  queues.set(vscode, pending.catch(() => {}));
  return pending;
}

// Use a hidden panel as the starting point: toggleMaximizedPanel then opens it
// maximized without accidentally restoring an already maximized panel.
async function arrangeSession(vscode, terminal) {
  const config = vscode.workspace.getConfiguration('herdr');
  if (config.get('autoArrangeSessions', true) && config.get('terminalLocation', 'panel') === 'panel') {
    const settings = [
      ['workbench', 'sideBar.location', 'left'],
      ['terminal.integrated', 'tabs.enabled', true],
      ['terminal.integrated', 'tabs.location', 'right'],
      ['terminal.integrated', 'tabs.hideCondition', 'never']
    ];
    for (const [section, key, value] of settings) {
      const target = vscode.workspace.getConfiguration(section);
      // An empty window has nowhere to save workspace settings yet. The
      // pending session focus reapplies them after worktree selection creates
      // its workspace; never fall back to changing the user's global settings.
      if ((vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length) && target.get(key) !== value) {
        await target.update(key, value, vscode.ConfigurationTarget.Workspace);
      }
    }
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.view.extension.herdr');
    await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
    await vscode.commands.executeCommand('workbench.action.alignPanelCenter');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
  }
  terminal.show();
}

module.exports = { showSession };
