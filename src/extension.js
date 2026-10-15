'use strict';

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const git = require('./git');
const model = require('./model');
const { Sessions } = require('./sessions');
const { Changes } = require('./changes');
const { WorktreeContext } = require('./worktree-context');

async function activate(context) {
  await WorktreeContext.restore(vscode, context);
  const log = vscode.window.createOutputChannel('Herdr Workbench');
  context.subscriptions.push(log);
  const reportError = error => {
    log.appendLine(error.stack || String(error));
    vscode.window.showErrorMessage(`Herdr: ${error.message || error}`);
  };
  let projects = context.workspaceState.get('projects', []);
  let currentPath = context.workspaceState.get('selectedWorktree');
  let panel;
  let refreshPromise;
  let refreshTimer;
  let pendingRefresh;
  let selectionGeneration = 0;
  const worktreeContext = new WorktreeContext(vscode, context);
  const emitter = new vscode.EventEmitter();
  context.subscriptions.push(emitter);
  let sessions;
  const changes = new Changes(vscode, context, error => log.appendLine(error.stack || String(error)));

  function snapshot() {
    return {
      projects: projects.map(project => ({ ...project, worktrees: (project.worktrees || []).map(worktree => ({ ...worktree })) })),
      sessions: model.sortSessions(sessions?.items || []).map(({ statusToken, statusFile, ...session }) => ({
        ...session, statusLabel: model.statusLabel(session), label: model.sessionLabel(session),
        indicator: model.agentIndicator(session),
        connected: session.backend === 'herdr' ? !!session.backendAlive : sessions.live.has(session.id),
        terminalAttached: sessions.live.has(session.id)
      })),
      selectedWorktree: currentPath,
      changes: {
        worktreePath: changes.repository?.rootUri.fsPath,
        files: changes.getChildren().flatMap(group => group.changes.map(change => ({
          path: change.uri.fsPath, staged: group.staged === true, conflict: group.conflict === true
        })))
      }
    };
  }

  function changed() {
    emitter.fire();
    const data = snapshot();
    panel?.webview.postMessage({ type: 'state', data });
    const running = data.sessions.filter(s => s.terminalAttached).length;
    const working = data.sessions.filter(s => s.indicator.state === 'working').length;
    const questions = data.sessions.filter(s => s.indicator.state === 'blocked').length;
    const done = data.sessions.filter(s => s.indicator.state === 'done').length;
    status.text = `$(terminal) ${running} session${running === 1 ? '' : 's'}${working ? ` · $(loading~spin) ${working}` : ''}${questions ? ` · ${questions} question${questions === 1 ? '' : 's'}` : ''}${done ? ` · ${done} finished` : ''}`;
    status.tooltip = 'Herdr: Open all CLI sessions';
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = 'herdr.overview';
  status.show();
  context.subscriptions.push(status);
  sessions = new Sessions(vscode, context, changed, reportError, { log: message => log.appendLine(message) });

  function sessionItem(session, detailed = false) {
    const item = new vscode.TreeItem(session.name);
    item.id = `session:${session.id}${detailed ? ':all' : ''}`;
    item.contextValue = 'herdrSession';
    item.sessionId = session.id;
    const background = session.backendAlive && !sessions.live.has(session.id);
    const label = `${model.sessionLabel(session)}${background ? ' · Background' : ''}`;
    item.description = detailed ? `${session.projectName} · ${label}` : label;
    item.tooltip = `${session.name}\n${session.worktreePath}\n${session.command}\n${model.statusLabel(session)}${background ? '\nRunning in background · Click to open terminal' : ''}${session.attention !== 'none' ? `\n${model.sessionLabel(session)}` : ''}`;
    const indicator = model.agentIndicator(session);
    item.iconPath = new vscode.ThemeIcon(indicator.icon, indicator.color ? new vscode.ThemeColor(indicator.color) : undefined);
    item.command = { command: 'herdr.focusSession', title: 'Open terminal', arguments: [session.id] };
    return item;
  }

  const projectProvider = {
    onDidChangeTreeData: emitter.event,
    getTreeItem: item => item,
    getChildren(item) {
      if (!item) return projects.map(project => {
        const tree = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.Expanded);
        tree.id = `project:${project.id}`;
        tree.projectId = project.id;
        tree.contextValue = 'herdrProject';
        tree.description = project.error ? 'Unavailable' : `${project.worktrees?.length || 0} worktree${project.worktrees?.length === 1 ? '' : 's'}`;
        tree.tooltip = project.error || project.path;
        tree.iconPath = new vscode.ThemeIcon(project.error ? 'warning' : 'repo');
        return tree;
      });
      const project = projects.find(p => p.id === item.projectId);
      if (!project) return [];
      if (item.contextValue === 'herdrProject') return (project.worktrees || []).map(worktree => {
        const tree = new vscode.TreeItem(worktree.branch || `detached · ${worktree.head?.slice(0, 7) || ''}`, vscode.TreeItemCollapsibleState.Expanded);
        tree.id = `worktree:${worktree.path}`;
        tree.projectId = project.id;
        tree.worktreePath = worktree.path;
        tree.contextValue = worktree.isMain ? 'herdrWorktreeMain' : 'herdrWorktree';
        tree.description = [worktree.path === currentPath ? 'Active' : '', worktree.error ? 'Unavailable' : `${worktree.changedFiles || 0} file${worktree.changedFiles === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
        tree.tooltip = worktree.error || worktree.path;
        tree.iconPath = new vscode.ThemeIcon(worktree.error ? 'warning' : 'git-branch');
        tree.command = { command: 'herdr.selectWorktree', title: 'Select worktree', arguments: [tree] };
        return tree;
      });
      if (item.contextValue?.startsWith('herdrWorktree')) return model.sortSessions(sessions.items.filter(s => s.worktreePath === item.worktreePath)).map(s => sessionItem(s));
      return [];
    }
  };
  const sessionProvider = {
    onDidChangeTreeData: emitter.event,
    getTreeItem: item => item,
    getChildren: item => item ? [] : model.sortSessions(sessions.items).map(s => sessionItem(s, true))
  };
  context.subscriptions.push(
    vscode.window.createTreeView('herdr.projects', { treeDataProvider: projectProvider, showCollapseAll: true }),
    vscode.window.createTreeView('herdr.sessions', { treeDataProvider: sessionProvider })
  );

  async function saveProjects() {
    await context.workspaceState.update('projects', projects.map(({ id, name, path: projectPath }) => ({ id, name, path: projectPath })));
    changed();
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const results = await Promise.allSettled(projects.map(async project => {
        try {
          const worktrees = await git.listWorktrees(project.path);
          const statusResults = await Promise.allSettled(worktrees.map(git.worktreeStatus));
          project.worktrees = statusResults.map((result, i) => result.status === 'fulfilled'
            ? result.value : { ...worktrees[i], error: String(result.reason) });
          delete project.error;
        } catch (error) {
          project.error = error.message;
          // Do not keep stale checkout entries actionable after a failed refresh.
          project.worktrees = [];
          log.appendLine(`${project.name}: ${error.message}`);
        }
      }));
      for (const result of results) if (result.status === 'rejected') log.appendLine(String(result.reason));
      changed();
    })().finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  }

  function scheduleRefresh() {
    clearTimeout(pendingRefresh);
    pendingRefresh = setTimeout(() => refresh().catch(reportError), 500);
  }

  function configureRefresh() {
    clearInterval(refreshTimer);
    const seconds = Math.max(3, Math.min(300, Number(vscode.workspace.getConfiguration('herdr').get('refreshInterval')) || 8));
    refreshTimer = setInterval(() => refresh().catch(reportError), seconds * 1000);
  }

  async function resolveWorktree(input) {
    await refresh();
    const requested = typeof input === 'string' ? input : input?.worktreePath;
    const candidates = projects.flatMap(project => (project.worktrees || []).filter(w => !w.error).map(worktree => ({ project, worktree })));
    const match = candidates.find(candidate => candidate.worktree.path === (requested || currentPath));
    if (match) return match;
    if (requested) throw new Error('This worktree is no longer available. Refresh the view.');
    const choice = await vscode.window.showQuickPick(candidates.map(candidate => ({
      label: `${candidate.project.name} / ${candidate.worktree.branch || 'detached'}`,
      description: candidate.worktree.path, candidate
    })), { placeHolder: 'Select worktree' });
    return choice?.candidate;
  }

  async function completeContextAction() {
    const action = context.workspaceState.get('worktreeContextAction');
    if (!action) return;
    await context.workspaceState.update('worktreeContextAction', undefined);
    if (action.type === 'session') return sessions.focus(action.sessionId);
    const commands = { explorer: 'workbench.view.explorer', scm: 'workbench.view.scm', changes: 'herdr.changes.focus' };
    if (commands[action.type]) await vscode.commands.executeCommand(commands[action.type]);
  }

  async function select(input, action) {
    const generation = ++selectionGeneration;
    const isCurrent = () => generation === selectionGeneration;
    const resolved = await resolveWorktree(input);
    if (!resolved || !isCurrent()) return;
    await changes.saveDrafts();
    if (!isCurrent()) return;
    if (!await changes.select(resolved.worktree)) return;
    if (!isCurrent()) return;
    currentPath = resolved.worktree.path;
    await context.workspaceState.update('selectedWorktree', currentPath);
    if (action) await context.workspaceState.update('worktreeContextAction', action);
    if (!isCurrent()) return;
    const switching = await worktreeContext.switch(resolved, isCurrent);
    changed();
    if (!switching && isCurrent()) await completeContextAction();
    return resolved;
  }

  function sessionId(input) { return typeof input === 'string' ? input : input?.sessionId; }

  function command(name, callback) {
    context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
      try { return await callback(...args); }
      catch (error) { reportError(error); throw error; }
    }));
  }

  command('herdr.refresh', async () => { await Promise.all([refresh(), sessions.refresh()]); });
  command('herdr.addProject', async input => {
    const uri = input instanceof vscode.Uri ? input : (await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Add project'
    }))?.[0];
    if (!uri) return;
    if (uri.scheme !== 'file') throw new Error('Select a directory on the extension host filesystem.');
    const project = await git.inspectProject(uri.fsPath);
    const existing = projects.find(p => p.id === project.id);
    if (!existing) {
      projects.push(project);
      await saveProjects();
    }
    await refresh();
    return project.id;
  });
  command('herdr.removeProject', async input => {
    const project = projects.find(p => p.id === input?.projectId);
    if (!project) return;
    if (sessions.items.some(s => s.projectId === project.id && (s.backendAlive || sessions.live.has(s.id)))) {
      throw new Error('Stop this project’s sessions first.');
    }
    projects = projects.filter(p => p.id !== project.id);
    await saveProjects();
  });
  command('herdr.selectWorktree', async input => {
    return select(input, { type: 'changes' });
  });
  command('herdr.addToWorkspace', async input => {
    if (worktreeContext.enabled()) return select(input, { type: 'explorer' });
    const resolved = await select(input);
    if (!resolved) return;
    const folders = vscode.workspace.workspaceFolders || [];
    const uri = vscode.Uri.file(resolved.worktree.path);
    if (folders.some(folder => folder.uri.toString() === uri.toString())) {
      await vscode.commands.executeCommand('workbench.view.explorer');
      return;
    }
    const accepted = vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
      uri, name: `${resolved.project.name} · ${resolved.worktree.branch || 'detached'}`
    });
    if (!accepted) throw new Error('The workspace could not be expanded.');
  });
  command('herdr.sourceControl', async input => {
    return select(input, { type: 'scm' });
  });
  command('herdr.openChange', item => changes.open(item));
  command('herdr.createWorktree', async input => {
    const selectedProject = projects.find(p => p.id === input?.projectId);
    const project = selectedProject || (await resolveWorktree(input))?.project;
    if (!project) return;
    const branches = await git.listBranches(project.path);
    const source = await vscode.window.showQuickPick([
      ...branches.map(branch => ({
        label: branch.name, description: branch.remote ? 'Remote branch' : branch.current ? 'Local branch · current' : 'Local branch',
        ref: branch.ref
      })),
      { label: '$(git-commit) HEAD', description: 'Current commit', ref: 'HEAD' },
      { label: '$(edit) Enter branch or commit …', custom: true }
    ], { title: 'New worktree', placeHolder: 'Select a starting branch', matchOnDescription: true, ignoreFocusOut: true });
    if (!source) return;
    const base = source.custom ? await vscode.window.showInputBox({
      title: 'New worktree', prompt: 'Starting branch or commit', placeHolder: 'Branch, tag or commit ID', ignoreFocusOut: true
    }) : source.ref;
    if (!base) return;
    const branch = await vscode.window.showInputBox({ title: 'New worktree', prompt: 'New branch name', placeHolder: 'feature/my-task', ignoreFocusOut: true });
    if (!branch) return;
    const destination = await vscode.window.showSaveDialog({
      title: 'New worktree directory', saveLabel: 'Create worktree here',
      defaultUri: vscode.Uri.file(path.join(path.dirname(project.path), `${project.name}-worktrees`, branch.replace(/[^\w.-]+/g, '-')))
    });
    if (!destination) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Creating worktree' },
      () => git.createWorktree(project.path, destination.fsPath, branch, base));
    await refresh();
    return destination.fsPath;
  });
  command('herdr.deleteWorktree', async input => {
    await refresh();
    const requested = typeof input === 'string' ? input : input?.worktreePath;
    // Resolve unavailable entries too, so Git can remove a missing worktree's registration.
    const candidates = projects.flatMap(project => (project.worktrees || []).filter(worktree => !worktree.isMain)
      .map(worktree => ({ project, worktree })));
    let resolved = candidates.find(candidate => candidate.worktree.path === (requested || currentPath));
    if (!resolved && requested) throw new Error('This worktree cannot be deleted. The main checkout is protected.');
    if (!resolved) resolved = (await vscode.window.showQuickPick(candidates.map(candidate => ({
      label: `${candidate.project.name} / ${candidate.worktree.branch || 'detached'}`,
      description: candidate.worktree.path, candidate
    })), { placeHolder: 'Select a worktree to delete' }))?.candidate;
    if (!resolved) return;
    const { project, worktree } = resolved;
    const verify = async () => {
      await sessions.refresh();
      if (sessions.items.some(session => session.worktreePath === worktree.path
        && (sessions.live.has(session.id) || session.backend === 'herdr' && !session.endedAt))) {
        throw new Error('Stop all sessions in this worktree first, including background sessions.');
      }
      if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file'
        && (document.uri.fsPath === worktree.path || document.uri.fsPath.startsWith(worktree.path + path.sep)))) {
        throw new Error('Save or close this worktree’s unsaved files first.');
      }
      if (worktree.locked) throw new Error('This worktree is locked. Unlock it in Git first.');
      if (!worktree.prunable) {
        const status = await git.worktreeStatus(worktree);
        if (status.error) throw new Error(status.error);
        if (status.changedFiles) throw new Error('This worktree contains uncommitted changes. Commit or preserve them before deleting it.');
      }
    };
    await verify();
    const choice = await vscode.window.showWarningMessage(`Delete worktree “${worktree.branch || 'detached'}”?`, {
      modal: true, detail: `${worktree.path}\n\nThe worktree directory will be deleted. The branch will be kept.`
    }, 'Delete worktree');
    if (choice !== 'Delete worktree') return;
    await verify();
    const fallback = project.worktrees.find(tree => tree.path !== worktree.path && !tree.error);
    // A project may originally have been added through the checkout being removed.
    const repositoryPath = project.path === worktree.path ? fallback?.path : project.path;
    if (!repositoryPath) throw new Error('No other available checkout was found for this project.');
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Deleting worktree' },
      () => git.removeWorktree(repositoryPath, worktree.path));
    if (project.path === worktree.path) project.path = repositoryPath;
    const wasSelected = currentPath === worktree.path;
    if (wasSelected) {
      ++selectionGeneration;
      currentPath = fallback?.path;
      await context.workspaceState.update('selectedWorktree', currentPath);
      await context.workspaceState.update('worktreeContextAction', undefined);
    }
    await saveProjects();
    await refresh();
    if (wasSelected && fallback) await select(fallback.path);
    if (worktreeContext.switching) return;
    // Manual multi-root workspaces must also drop the deleted folder.
    const folders = vscode.workspace.workspaceFolders || [];
    const index = folders.findIndex(folder => folder.uri.fsPath === worktree.path);
    if (index !== -1 && !vscode.workspace.updateWorkspaceFolders(index, 1)) {
      throw new Error('Worktree deleted; its folder could not be removed from the workspace.');
    }
  });
  command('herdr.startSession', async input => {
    const resolved = await resolveWorktree(input);
    if (!resolved) return;
    await fs.access(resolved.worktree.path);
    const profiles = model.profiles(vscode.workspace.getConfiguration('herdr').get('agentProfiles', []));
    const inventory = await sessions.availableProfiles(profiles);
    for (const profile of inventory.unavailable) log.appendLine(`${profile.name}: ${profile.reason}`);
    let profile = input?.profileId ? inventory.available.find(p => p.id === input.profileId) : undefined;
    if (input?.profileId && !profile) throw new Error('This agent profile is unavailable: its CLI is missing or unsupported by herdr.');
    if (!profile) {
      const choice = await vscode.window.showQuickPick([
        ...inventory.available.map(p => ({ label: p.name, description: p.command, profile: p })),
        { label: '$(settings-gear) Configure agent profiles …', configure: true }
      ], { title: `${resolved.project.name} / ${resolved.worktree.branch || 'detached'}`,
        placeHolder: inventory.available.length ? 'Select an installed CLI for this session' : 'No supported CLI found · Configure an executable path or profile' });
      if (!choice) return;
      if (choice.configure) return vscode.commands.executeCommand('herdr.configureProfiles');
      profile = choice.profile;
    }
    const session = await sessions.start(resolved.worktree, resolved.project, profile);
    if (worktreeContext.enabled()) await select(resolved.worktree.path, { type: 'session', sessionId: session.id });
    return session;
  });
  command('herdr.focusSession', async input => {
    const id = sessionId(input);
    const session = sessions.find(id);
    if (session && worktreeContext.enabled()) return select(session.worktreePath, { type: 'session', sessionId: id });
    return sessions.focus(id);
  });
  command('herdr.interruptSession', input => sessions.interrupt(sessionId(input)));
  command('herdr.stopSession', input => sessions.stop(sessionId(input)));
  command('herdr.forgetSession', input => sessions.forget(sessionId(input)));
  command('herdr.deleteSession', async input => {
    const id = sessionId(input);
    const session = sessions.find(id);
    if (!session) return;
    if (!session.endedAt) {
      const choice = await vscode.window.showWarningMessage(`Delete session “${session.name}”?`, {
        modal: true, detail: 'The running agent will be stopped and the session removed from history.'
      }, 'Delete session');
      if (choice !== 'Delete session') return;
    }
    await sessions.remove(id);
  });
  command('herdr.markSession', async input => {
    const id = sessionId(input);
    if (!sessions.find(id)) return;
    const choice = await vscode.window.showQuickPick([
      { label: 'Clear flag', value: 'none' },
      { label: 'Needs input', description: 'Manual flag', value: 'input' },
      { label: 'Ready for review', description: 'Manual flag', value: 'review' }
    ], { placeHolder: 'Set a manual session flag' });
    if (choice) sessions.update(id, { attention: choice.value });
  });
  command('herdr.configureProfiles', () => vscode.commands.executeCommand('workbench.action.openSettings', 'herdr.agentProfiles'));
  command('herdr.detectClis', async () => {
    const inventory = await sessions.availableProfiles(model.profiles(vscode.workspace.getConfiguration('herdr').get('agentProfiles', [])));
    if (!inventory.available.length) {
      await vscode.window.showInformationMessage('Herdr: No supported CLI found. Configure custom executable paths in herdr.agentProfiles.');
    } else await vscode.window.showQuickPick(inventory.available.map(profile => ({ label: profile.name, description: profile.executable })),
      { title: `${inventory.backend} · Installed agents`, placeHolder: 'Checked again whenever a session starts' });
    return inventory;
  });

  command('herdr.overview', async () => {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('herdr.overview', 'Herdr · Sessions', vscode.ViewColumn.Active, {
      enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'herdr.svg');
    const webview = panel.webview;
    const nonce = randomBytes(18).toString('base64');
    const stylesheet = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'dashboard.css'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'dashboard.js'));
    webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${stylesheet}"><title>Herdr · Sessions</title></head><body><main id="app"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const messages = webview.onDidReceiveMessage(async message => {
      if (!message || typeof message.type !== 'string') return;
      const data = snapshot();
      const worktree = data.projects.flatMap(p => p.worktrees).find(w => w.path === message.worktreePath);
      const session = data.sessions.find(s => s.id === message.sessionId);
      const actions = {
        ready: () => webview.postMessage({ type: 'state', data }),
        refresh: () => vscode.commands.executeCommand('herdr.refresh'),
        addProject: () => vscode.commands.executeCommand('herdr.addProject'),
        profiles: () => vscode.commands.executeCommand('herdr.detectClis'),
        start: () => worktree && vscode.commands.executeCommand('herdr.startSession', { worktreePath: worktree.path }),
        select: () => worktree && vscode.commands.executeCommand('herdr.selectWorktree', { worktreePath: worktree.path }),
        workspace: () => worktree && vscode.commands.executeCommand('herdr.addToWorkspace', { worktreePath: worktree.path }),
        deleteWorktree: () => worktree && vscode.commands.executeCommand('herdr.deleteWorktree', { worktreePath: worktree.path }),
        terminal: () => session && vscode.commands.executeCommand('herdr.focusSession', session.id),
        mark: () => session && vscode.commands.executeCommand('herdr.markSession', session.id),
        interrupt: () => session && vscode.commands.executeCommand('herdr.interruptSession', session.id),
        stop: () => session && vscode.commands.executeCommand('herdr.stopSession', session.id),
        deleteSession: () => session && vscode.commands.executeCommand('herdr.deleteSession', session.id),
        forget: () => session && vscode.commands.executeCommand('herdr.forgetSession', session.id)
      };
      try { if (Object.hasOwn(actions, message.type)) await actions[message.type](); }
      catch (error) { log.appendLine(error.message); }
    });
    const disposed = panel.onDidDispose(() => { messages.dispose(); disposed.dispose(); panel = undefined; });
    context.subscriptions.push(panel);
  });

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(scheduleRefresh),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      worktreeContext.switching = false;
      if (currentPath && worktreeContext.enabled()) select(currentPath).catch(reportError);
    }),
    vscode.window.onDidChangeWindowState(state => { if (state.focused) scheduleRefresh(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('herdr.refreshInterval')) configureRefresh();
      if (event.affectsConfiguration('herdr.switchWorkspaceOnSelect')) {
        if (!worktreeContext.enabled()) worktreeContext.releaseTerminalDirectory().catch(reportError);
        else if (currentPath) select(currentPath).catch(reportError);
      }
    }),
    { dispose: () => { clearInterval(refreshTimer); clearTimeout(pendingRefresh); } }
  );
  configureRefresh();
  refresh().then(async () => {
    if (currentPath && projects.some(p => p.worktrees?.some(w => w.path === currentPath && !w.error))) {
      try { await select(currentPath); } catch (error) { log.appendLine(error.message); }
    }
  }).catch(reportError);
  changed();

  // A read-only API is useful for integrations and the extension-host smoke test.
  return { getSnapshot: snapshot, refresh };
}

module.exports = { activate };
