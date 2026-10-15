'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const SETTINGS = require('../package.json').contributes.configuration.properties;

class WorktreeContext {
  constructor(vscode, context) {
    this.vscode = vscode;
    this.context = context;
  }

  static async restore(vscode, context) {
    const transfers = context.globalState.get('worktreeWorkspaceTransfers', {});
    const key = vscode.workspace.workspaceFile?.toString();
    let transfer = transfers[key];
    const folderTransfers = context.globalState.get('worktreeFolderTransfers', {});
    const folderTransfer = folderTransfers[vscode.env.sessionId];
    const roots = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString());
    const matchesFolderTransfer = vscode.workspace.workspaceFile && folderTransfer
      && JSON.stringify(roots) === JSON.stringify(folderTransfer.roots);
    if (!transfer && matchesFolderTransfer) transfer = folderTransfer.values;
    if (!transfer) return;
    // A folder window has a different storage identity from a named workspace.
    // Transfer only this extension's memento before creating its managers.
    for (const [name, value] of Object.entries(transfer)) await context.workspaceState.update(name, value);
    delete transfers[key];
    await context.globalState.update('worktreeWorkspaceTransfers', transfers);
    if (matchesFolderTransfer) {
      delete folderTransfers[vscode.env.sessionId];
      await context.globalState.update('worktreeFolderTransfers', folderTransfers);
    }
  }

  enabled() { return this.vscode.workspace.getConfiguration('herdr').get('switchWorkspaceOnSelect', true); }

  async terminalDirectory(worktreePath) {
    const config = this.vscode.workspace.getConfiguration('terminal.integrated');
    if (!this.context.workspaceState.get('worktreeTerminalDefaults')) {
      await this.context.workspaceState.update('worktreeTerminalDefaults', {
        cwd: config.inspect('cwd')?.workspaceValue ?? null,
        splitCwd: config.inspect('splitCwd')?.workspaceValue ?? null
      });
    }
    for (const [name, value] of [['cwd', worktreePath], ['splitCwd', 'workspaceRoot']]) {
      if (config.inspect(name)?.workspaceValue !== value) {
        await config.update(name, value, this.vscode.ConfigurationTarget.Workspace);
      }
    }
  }

  async releaseTerminalDirectory() {
    const defaults = this.context.workspaceState.get('worktreeTerminalDefaults');
    if (!defaults) return;
    const config = this.vscode.workspace.getConfiguration('terminal.integrated');
    for (const [name, value] of Object.entries(defaults)) await config.update(name, value === null ? undefined : value, this.vscode.ConfigurationTarget.Workspace);
    await this.context.workspaceState.update('worktreeTerminalDefaults', undefined);
  }

  async switch(resolved, isCurrent = () => true) {
    if (!this.enabled()) return false;
    if (this.switching) return true;
    const { vscode, context } = this;
    const { worktree, project } = resolved;
    const uri = vscode.Uri.file(worktree.path);
    const folders = vscode.workspace.workspaceFolders || [];
    const alreadySelected = folders.length === 1 && folders[0].uri.toString() === uri.toString();
    if (!vscode.workspace.workspaceFile) {
      if (alreadySelected) return false;
      if (folders.length) {
        // Let VS Code convert the folder window into an untitled workspace in
        // place, retaining ordinary terminals. Its new storage identity needs
        // our catalog transferred before the next activation reduces the roots.
        const transfers = context.globalState.get('worktreeFolderTransfers', {});
        transfers[vscode.env.sessionId] = {
          roots: [...folders.map(folder => folder.uri.toString()), uri.toString()],
          values: Object.fromEntries(context.workspaceState.keys().map(key => [key, context.workspaceState.get(key)]))
        };
        await context.globalState.update('worktreeFolderTransfers', transfers);
        if (!isCurrent()) return false;
        this.switching = true;
        if (!vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
          uri, name: `${project.name} · ${worktree.branch || 'detached'}`
        })) {
          this.switching = false;
          throw new Error('The folder window could not be converted into a workspace.');
        }
        return true;
      }
      // Keep a stable workspace identity across future root replacements. Do
      // not rewrite the project's .vscode/settings.json or reopen it as a new
      // single-folder workspace (which would lose the project/session catalog).
      const settings = {};
      const config = vscode.workspace.getConfiguration();
      for (const name of Object.keys(SETTINGS)) {
        const value = config.inspect(name)?.workspaceValue;
        if (value !== undefined) settings[name] = value;
      }
      settings['terminal.integrated.cwd'] = worktree.path;
      settings['terminal.integrated.splitCwd'] = 'workspaceRoot';
      await context.workspaceState.update('worktreeTerminalDefaults', { cwd: null, splitCwd: null });
      const directory = path.join(context.globalStorageUri.fsPath, 'workspaces');
      const target = vscode.Uri.file(path.join(directory, `workbench-${randomUUID()}.code-workspace`));
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(target.fsPath, JSON.stringify({ folders: [{ path: worktree.path, name: `${project.name} · ${worktree.branch || 'detached'}` }], settings }, null, 2) + '\n', { flag: 'wx' });
      if (!isCurrent()) { await fs.unlink(target.fsPath); return false; }
      const transfers = context.globalState.get('worktreeWorkspaceTransfers', {});
      transfers[target.toString()] = Object.fromEntries(context.workspaceState.keys().map(key => [key, context.workspaceState.get(key)]));
      await context.globalState.update('worktreeWorkspaceTransfers', transfers);
      this.switching = true;
      await vscode.commands.executeCommand('vscode.openFolder', target, { forceReuseWindow: true });
      return true;
    }
    await this.terminalDirectory(worktree.path);
    if (!isCurrent()) return false;
    if (alreadySelected) return false;
    this.switching = true;
    const accepted = vscode.workspace.updateWorkspaceFolders(0, folders.length, {
      uri, name: `${project.name} · ${worktree.branch || 'detached'}`
    });
    if (!accepted) {
      this.switching = false;
      throw new Error('The workspace could not be switched to this worktree.');
    }
    // The first root changed: VS Code can restart this extension host. All
    // state and any pending UI action must already have been persisted.
    return true;
  }
}

module.exports = { WorktreeContext };
