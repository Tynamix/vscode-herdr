'use strict';

const path = require('node:path');

class Changes {
  constructor(vscode, context, reportError = console.error) {
    this.vscode = vscode;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.generation = 0;
    this.pending = Promise.resolve();
    this.reportError = reportError;
    this.context = context;
    this.commitDrafts = new Map(context.workspaceState.get('gitCommitDrafts', []));
    this.restoredDrafts = new Set();
    this.tree = vscode.window.createTreeView('herdr.changes', { treeDataProvider: this, showCollapseAll: true });
    context.subscriptions.push(this.emitter, this.tree,
      vscode.workspace.registerTextDocumentContentProvider('herdr-empty', { provideTextDocumentContent: () => '' }),
      { dispose: () => {
        this.disposed = true;
        this.listener?.dispose();
        this.repositoryListener?.dispose();
      } });
  }

  select(worktree) {
    const generation = ++this.generation;
    this.listener?.dispose();
    this.repository = undefined;
    this.tree.description = worktree.branch || path.basename(worktree.path);
    this.emitter.fire();
    // Serialize native repository changes, so an older click cannot close the
    // repository opened by a newer click. Unstarted selections are superseded.
    const operation = this.pending.catch(() => {}).then(() => this.applySelection(worktree, generation));
    this.pending = operation;
    return operation;
  }

  async applySelection(worktree, generation) {
    if (this.disposed || generation !== this.generation) return;
    const extension = this.vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('Die integrierte Git-Erweiterung von VS Code ist nicht verfügbar.');
    const gitExtension = await extension.activate();
    if (!gitExtension.enabled) throw new Error('Bitte die integrierte Git-Erweiterung aktivieren.');
    const api = gitExtension.getAPI(1);
    if (this.disposed || generation !== this.generation) return;
    if (this.api !== api) {
      this.repositoryListener?.dispose();
      this.api = api;
      this.repositoryListener = api.onDidOpenRepository(repository => {
        if (!this.repository || repository.rootUri.toString() === this.repository.rootUri.toString()) return;
        // Workspace discovery can open another provider after a selection.
        // Keep the native Git view scoped without touching files or terminals.
        this.pending = this.pending.catch(() => {}).then(() => this.keepSelectedRepository());
        this.pending.catch(this.reportError);
      });
    }
    const repository = await this.openSelectedRepository(this.vscode.Uri.file(worktree.path));
    if (!repository) throw new Error('Git konnte diesen Worktree nicht öffnen.');
    await repository.status();
    if (this.disposed || generation !== this.generation) return;
    this.setRepository(repository);
    return repository;
  }

  async keepSelectedRepository() {
    if (!this.disposed && this.repository) {
      const generation = this.generation;
      const repository = await this.openSelectedRepository(this.repository.rootUri);
      if (repository && !this.disposed && generation === this.generation) {
        await repository.status();
        if (!this.disposed && generation === this.generation) this.setRepository(repository);
      }
    }
  }

  async openSelectedRepository(uri) {
    const others = this.api.repositories.filter(repository => repository.rootUri.toString() !== uri.toString());
    if (others.length) {
      // Preserve drafts before disposing providers, including the selected one:
      // closing a main repository can also dispose its linked worktree providers.
      await this.saveDrafts();
      for (const repository of others) {
        if (this.api.repositories.some(open => open.rootUri.toString() === repository.rootUri.toString())) {
          await this.vscode.commands.executeCommand('git.close', repository.rootUri);
        }
      }
    }
    // Open after closing the old providers. Doing this in the opposite order can
    // close the newly selected worktree together with its previous main provider.
    const wasOpen = this.api.repositories.some(repository => repository.rootUri.toString() === uri.toString());
    const repository = await this.api.openRepository(uri);
    if (repository && (!wasOpen || !this.restoredDrafts.has(uri.toString())) && !repository.inputBox.value && this.commitDrafts.has(uri.toString())) {
      repository.inputBox.value = this.commitDrafts.get(uri.toString());
    }
    this.restoredDrafts.add(uri.toString());
    return repository;
  }

  async saveDrafts() {
    for (const repository of this.api?.repositories || []) {
      this.commitDrafts.set(repository.rootUri.toString(), repository.inputBox.value);
    }
    await this.context.workspaceState.update('gitCommitDrafts', [...this.commitDrafts]);
  }

  setRepository(repository) {
    this.listener?.dispose();
    this.repository = repository;
    this.listener = repository.state.onDidChange(() => this.emitter.fire());
    this.emitter.fire();
  }

  getChildren(item) {
    if (!this.repository) return [];
    const repositoryPath = this.repository.rootUri.fsPath;
    if (item?.type === 'group') return item.repositoryPath !== repositoryPath ? [] : item.changes.map(change => ({
      type: 'change', change, staged: item.staged, conflict: item.conflict, repositoryPath
    }));
    if (item) return [];
    const state = this.repository.state;
    return [
      { label: 'Merge-Konflikte', changes: state.mergeChanges || [], conflict: true },
      { label: 'Vorgemerkte Änderungen', changes: state.indexChanges || [], staged: true },
      { label: 'Änderungen', changes: state.workingTreeChanges || [], staged: false },
      { label: 'Neue Dateien', changes: state.untrackedChanges || [], staged: false }
    ].filter(group => group.changes.length).map(group => ({ ...group, type: 'group', repositoryPath }));
  }

  getTreeItem(item) {
    const v = this.vscode;
    if (item.type === 'group') {
      const tree = new v.TreeItem(item.label, v.TreeItemCollapsibleState.Expanded);
      tree.id = `${item.repositoryPath}:group:${item.label}`;
      tree.description = String(item.changes.length);
      return tree;
    }
    const uri = item.change.renameUri || item.change.uri;
    const tree = new v.TreeItem(path.basename(uri.fsPath));
    tree.id = `${item.repositoryPath}:${item.staged ? 'index' : item.conflict ? 'merge' : 'working'}:${uri.toString()}`;
    tree.resourceUri = uri;
    const relative = path.relative(item.repositoryPath, path.dirname(uri.fsPath));
    tree.description = relative || undefined;
    tree.tooltip = uri.fsPath;
    tree.command = { command: 'herdr.openChange', title: 'Diff öffnen', arguments: [item] };
    return tree;
  }

  async open(item) {
    if (!item?.change || !this.api) return;
    if (item.repositoryPath && item.repositoryPath !== this.repository?.rootUri.fsPath) return;
    const v = this.vscode;
    const change = item.change;
    const target = change.renameUri || change.uri;
    if (item.conflict) return v.window.showTextDocument(target, { preview: false });
    const empty = v.Uri.from({ scheme: 'herdr-empty', path: target.path });
    const added = item.staged ? change.status === 1 : [7, 10].includes(change.status);
    const deleted = item.staged ? change.status === 2 : change.status === 6;
    const left = added ? empty : this.api.toGitUri(change.originalUri, item.staged ? 'HEAD' : '');
    const right = deleted ? empty : item.staged ? this.api.toGitUri(target, '') : target;
    return v.commands.executeCommand('vscode.diff', left, right,
      `${path.basename(target.fsPath)} · ${item.staged ? 'Index' : 'Arbeitsverzeichnis'}`, { preview: false });
  }
}

module.exports = { Changes };
