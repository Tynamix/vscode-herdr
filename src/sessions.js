'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { restoreSessions } = require('./model');
const { HerdrBackend } = require('./herdr-backend');
const { HerdrTerminal } = require('./herdr-terminal');
const { discoverProfiles, commandExecutable, quoteShell } = require('./cli-discovery');

class Sessions {
  constructor(vscode, context, changed, reportError, options = {}) {
    Object.assign(this, { vscode, context, changed, reportError });
    this.items = restoreSessions(context.workspaceState.get('sessions', [])).map(item => ({ ...item, backendAlive: false }));
    this.live = new Map();
    this.attaching = new Set();
    this.backendSession = context.workspaceState.get('herdrBackendSession') || `vscode-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    this.ready = context.workspaceState.update('herdrBackendSession', this.backendSession);
    this.backend = options.backend || new HerdrBackend({
      directory: path.join(context.globalStorageUri.fsPath, 'backends', this.backendSession),
      sessionName: this.backendSession,
      executable: vscode.workspace.getConfiguration('herdr').get('executablePath') || 'herdr',
      log: options.log
    });
    this.makeController = options.makeController || ((paneId, disconnected) => new HerdrTerminal(vscode, this.backend, paneId, disconnected));
    context.subscriptions.push(
      vscode.window.onDidOpenTerminal(terminal => this.reconnect(terminal)),
      vscode.window.onDidCloseTerminal(terminal => this.closed(terminal)),
      vscode.window.onDidChangeActiveTerminal(terminal => {
        for (const [id, runtime] of this.live) if (runtime.terminal === terminal && !this.attaching.has(id)) this.markSeen(id);
      }), this
    );
    for (const terminal of vscode.window.terminals) this.reconnect(terminal);
    this.timer = setInterval(() => this.refresh().catch(() => {}), 1500);
    this.timer.unref?.();
    this.ready.then(() => this.refresh()).catch(reportError);
  }

  find(id) { return this.items.find(session => session.id === id); }

  async save() {
    await this.context.workspaceState.update('sessions', this.items.map(item => ({ ...item })));
    if (!this.disposed) this.changed();
  }

  update(id, patch) {
    const session = this.find(id);
    if (!session) return;
    Object.assign(session, patch);
    this.save().catch(this.reportError);
  }

  async availableProfiles(profiles) {
    const info = await this.backend.inspect();
    return { ...await discoverProfiles({ supportedKinds: info.supportedKinds, profiles }), backend: info.version };
  }

  // Existing direct terminals remain usable until the user closes them. They
  // cannot be moved into a daemon without restarting their agent process.
  reconnect(terminal) {
    const id = terminal.creationOptions?.env?.HERDR_WORKBENCH_SESSION;
    const session = this.items.find(item => item.id === id || terminal.name === item.terminalName);
    if (!session || this.live.has(session.id) || this.attaching.has(session.id)) return;
    if (session.backend === 'herdr') {
      terminal.dispose(); // Stale renderer; the daemon still owns the process.
      return;
    }
    this.live.set(session.id, { terminal });
    this.update(session.id, { status: 'unknown', agentState: 'unknown' });
  }

  async start(worktree, project, profile) {
    if (!this.vscode.workspace.isTrusted) throw new Error('CLI-Sessions brauchen einen vertrauenswürdigen Workspace.');
    await this.ready;
    await this.backend.ensure();
    const id = randomUUID();
    const name = `${profile.name} · ${worktree.branch || 'detached'}`;
    const created = await this.backend.create(worktree.path, `vscode:${id} ${name}`);
    const session = {
      id, name, terminalName: `Herdr · ${name} · ${id.slice(0, 8)}`,
      projectId: project.id, projectName: project.name, worktreePath: worktree.path, branch: worktree.branch,
      profileId: profile.id, profileName: profile.name, kind: profile.kind, command: profile.command,
      createdAt: Date.now(), status: 'starting', attention: 'none', agentState: 'unknown', unreadCompletion: false,
      backend: 'herdr', backendSession: this.backendSession, backendAlive: true,
      workspaceId: created.workspace.workspace_id, paneId: created.root_pane.pane_id, terminalId: created.root_pane.terminal_id
    };
    this.items.push(session);
    await this.save();
    let command = profile.command;
    if (profile.kind === 'pi') {
      const parsed = commandExecutable(command);
      if (!parsed) throw new Error('Pi muss direkt über seine ausführbare Datei gestartet werden.');
      command = command.slice(0, parsed.end) + ' --extension '
        + quoteShell(path.join(this.context.extensionUri.fsPath, 'integrations', 'pi-status.mjs')) + command.slice(parsed.end);
    }
    // Never retry pane.run: a timeout can mean the command was already sent.
    session.launchAttempted = true;
    await this.save();
    try { await this.backend.run(session.paneId, command); }
    catch (error) {
      this.update(id, { status: 'unknown' });
      throw new Error(`CLI-Start konnte nicht bestätigt werden. Öffne die vorhandene Session zur Prüfung. ${error.message}`);
    }
    this.update(id, { status: 'running' });
    await this.refresh();
    try { await this.attach(session); }
    catch (error) { this.reportError(new Error(`Session läuft im Hintergrund; Terminal konnte nicht verbunden werden: ${error.message}`)); }
    return { ...session };
  }

  async attach(session) {
    const existing = this.live.get(session.id);
    if (existing) { existing.terminal.show(); return; }
    if (this.attaching.has(session.id)) return;
    this.attaching.add(session.id);
    let runtime;
    try {
      const controller = this.makeController(session.paneId, error => {
        if (this.live.get(session.id) !== runtime) return;
        this.live.delete(session.id);
        this.changed();
        if (error && !this.disposed && !this.attaching.has(session.id)) this.reportError(error);
      });
      const terminal = this.vscode.window.createTerminal({
        name: session.terminalName, pty: controller, isTransient: true,
        iconPath: new this.vscode.ThemeIcon('terminal'),
        location: this.vscode.workspace.getConfiguration('herdr').get('terminalLocation') === 'editor'
          ? this.vscode.TerminalLocation.Editor : this.vscode.TerminalLocation.Panel
      });
      runtime = { terminal, controller };
      this.live.set(session.id, runtime);
      terminal.show();
      await controller.ready;
      this.changed();
    } catch (error) {
      if (runtime) { this.live.delete(session.id); runtime.controller.dispose(); runtime.terminal.dispose(); }
      throw error;
    } finally { this.attaching.delete(session.id); }
  }

  agentPatch(session, pane, agent) {
    const state = agent?.agent_status || pane.agent_status || 'unknown';
    const sameTerminal = session.terminalId === pane.terminal_id;
    const observedWork = sameTerminal && (session.pendingCompletion || session.agentState === 'working');
    const completed = ['idle', 'done'].includes(state) && (state === 'done' || agent?.completion_seq != null || observedWork);
    const key = completed ? `${pane.terminal_id}:${agent?.completion_seq ?? agent?.state_change_seq ?? 'done'}` : sameTerminal ? session.completionKey : undefined;
    return {
      agentSource: 'herdr', agentState: state === 'done' ? 'idle' : state,
      pendingCompletion: state === 'working' || state === 'blocked' && !!observedWork,
      completionKey: key,
      unreadCompletion: ['working', 'blocked'].includes(state) ? false : completed ? key !== session.seenCompletionKey : sameTerminal && !!session.unreadCompletion
    };
  }

  async refresh() {
    if (this.disposed) return;
    if (!this.items.some(item => item.backend === 'herdr' && !item.endedAt)) {
      this.subscription?.dispose();
      this.subscription = undefined;
      this.subscriptionKey = undefined;
      return;
    }
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      let snapshot;
      try { snapshot = await this.backend.snapshot(); } catch { /* The next poll reconnects without launching a server. */ }
      if (this.disposed) return;
      let dirty = false;
      const panes = [];
      for (const session of this.items.filter(item => item.backend === 'herdr')) {
        if (session.endedAt) continue;
        const workspace = snapshot?.workspaces.find(item => item.workspace_id === session.workspaceId && item.label?.startsWith(`vscode:${session.id} `));
        const pane = workspace && snapshot.panes.find(item => item.pane_id === session.paneId && item.workspace_id === session.workspaceId);
        const agent = pane && snapshot.agents?.find(item => item.pane_id === pane.pane_id);
        const patch = pane ? { backendAlive: true, status: 'running', terminalId: pane.terminal_id, ...this.agentPatch(session, pane, agent) }
          : { backendAlive: false, status: snapshot ? 'closed' : 'detached', agentState: snapshot ? 'idle' : 'unknown', unreadCompletion: false,
            ...(snapshot ? { endedAt: Date.now(), pendingCompletion: false } : {}) };
        if (pane) panes.push(session.paneId);
        if (Object.entries(patch).some(([key, value]) => session[key] !== value)) { Object.assign(session, patch); dirty = true; }
      }
      const subscriptionKey = panes.sort().join(',');
      if (subscriptionKey !== this.subscriptionKey) {
        this.subscription?.dispose();
        this.subscriptionKey = subscriptionKey;
        this.subscription = this.backend.subscribe(panes, event => {
          // Keep evidence of short turns even when both transitions happen
          // between snapshots. Completion itself uses the stable snapshot seq.
          const data = event?.data;
          const session = data && this.items.find(item => item.paneId === data.pane_id && item.workspaceId === data.workspace_id);
          if (!this.disposed && session && !session.endedAt && ['working', 'blocked'].includes(data.agent_status)) {
            this.update(session.id, { agentState: data.agent_status, unreadCompletion: false,
              pendingCompletion: data.agent_status === 'working' || !!session.pendingCompletion });
          }
          clearTimeout(this.eventTimer);
          this.eventTimer = setTimeout(() => this.refresh().catch(() => {}), 30);
        }, () => { this.subscriptionKey = undefined; });
      }
      if (dirty) await this.save();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  markSeen(id) {
    const session = this.find(id);
    if (!session) return;
    if (session.unreadCompletion) this.update(id, { unreadCompletion: false, seenCompletionKey: session.completionKey });
    if (session.backend === 'herdr' && session.backendAlive) this.backend.focus(session.paneId).catch(() => {});
  }

  async focus(id) {
    const session = this.find(id);
    if (!session) throw new Error('Diese Session gibt es nicht mehr.');
    if (session.backend !== 'herdr') {
      const runtime = this.live.get(id);
      if (!runtime) throw new Error('Für diese alte Session ist kein Terminal verbunden. Bitte eine neue Session starten.');
      this.markSeen(id);
      runtime.terminal.show();
      return;
    }
    if (session.endedAt) throw new Error('Diese Session wurde beendet und bleibt im Verlauf sichtbar.');
    await this.backend.ensure();
    await this.refresh();
    if (!session.backendAlive) throw new Error('Diese Session wurde beendet und bleibt im Verlauf sichtbar.');
    this.markSeen(id);
    await this.attach(session);
  }

  closed(terminal) {
    for (const [id, runtime] of this.live) {
      if (runtime.terminal !== terminal) continue;
      this.live.delete(id);
      runtime.controller?.dispose();
      if (this.find(id)?.backend !== 'herdr') this.update(id, { status: 'closed', agentState: 'idle', endedAt: Date.now() });
      else this.changed();
    }
  }

  async interrupt(id) {
    const session = this.find(id);
    if (session?.backend === 'herdr' && session.backendAlive) return this.backend.interrupt(session.paneId);
    const runtime = this.live.get(id);
    if (!runtime) throw new Error('Für diese Session ist kein Terminal verbunden.');
    runtime.terminal.sendText('\u0003', false);
  }

  closeTerminal(id) {
    const runtime = this.live.get(id);
    this.live.delete(id);
    runtime?.controller?.dispose();
    runtime?.terminal.dispose();
  }

  async stop(id) {
    const session = this.find(id);
    if (!session) return;
    if (session.backend === 'herdr') {
      // Verify ownership before closing anything in the persistent server.
      await this.refresh();
      if (!session.backendAlive) throw new Error('Session ist nicht mit herdr verbunden.');
      await this.backend.stop(session.workspaceId);
    }
    this.closeTerminal(id);
    Object.assign(session, { backendAlive: false, status: 'closed', agentState: 'idle', pendingCompletion: false, unreadCompletion: false, endedAt: Date.now() });
    await this.save();
  }

  async forget(id) {
    await this.refresh();
    const session = this.find(id);
    if (session?.backend === 'herdr' && session.status === 'detached') throw new Error('Herdr ist nicht erreichbar. Verbinde die Session zuerst erneut, um ihren Zustand zu prüfen.');
    if (session?.backendAlive || this.live.has(id)) throw new Error('Beende zuerst die Session über „Session beenden“.');
    this.items = this.items.filter(item => item.id !== id);
    await this.save();
  }

  async remove(id) {
    await this.refresh();
    const session = this.find(id);
    if (!session) return;
    if (session.backend === 'herdr' && !session.endedAt && !session.backendAlive) {
      throw new Error('Herdr ist nicht erreichbar. Verbinde die Session zuerst erneut, um ihren Zustand zu prüfen.');
    }
    if (session.endedAt) this.closeTerminal(id);
    else if (session.backendAlive || this.live.has(id)) await this.stop(id);
    await this.forget(id);
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.eventTimer);
    this.subscription?.dispose();
    for (const runtime of this.live.values()) runtime.controller?.dispose();
    this.live.clear();
  }
}

module.exports = { Sessions };
