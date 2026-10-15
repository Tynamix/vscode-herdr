'use strict';

(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = { projects: [], sessions: [] };
  let filter = vscode.getState()?.filter || 'all';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, type, details = {}, className = '') {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', () => vscode.postMessage({ type, ...details }));
    return node;
  }

  function trashButton(label, type, details) {
    const node = button('', type, details, 'small quiet icon-button');
    node.title = label;
    node.setAttribute('aria-label', label);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', 'M6 2h4l1 2h3v1H2V4h3l1-2zm1 .9L6.5 4h3L9 2.9H7zM3 6h1v7h8V6h1v7.5l-.5.5h-9l-.5-.5V6zm3 0h1v6H6V6zm3 0h1v6H9V6z');
    icon.append(shape);
    node.append(icon);
    return node;
  }

  function render() {
    app.replaceChildren();
    const header = el('header', 'header');
    const title = el('div');
    title.append(el('div', 'eyebrow', 'HERDR WORKBENCH'), el('h1', '', 'Session overview'));
    const live = state.sessions.filter(s => s.terminalAttached);
    const attention = state.sessions.filter(s => ['blocked', 'done'].includes(s.indicator.state));
    title.append(el('p', 'subtle', `${state.projects.length} project${state.projects.length === 1 ? '' : 's'} · ${live.length} open CLI session${live.length === 1 ? '' : 's'}${attention.length ? ` · ${attention.length} need${attention.length === 1 ? 's' : ''} attention` : ''}`));
    const actions = el('div', 'actions');
    actions.append(button('Installed agents', 'profiles', {}, 'secondary'), button('Refresh', 'refresh', {}, 'secondary'), button('+ Project', 'addProject'));
    header.append(title, actions);
    app.append(header);

    if (!state.projects.length) {
      const empty = el('section', 'empty welcome');
      empty.append(el('h2', '', 'Your projects, together in one workbench.'),
        el('p', 'subtle', 'Add a Git project. Existing worktrees appear automatically.'),
        button('Add your first project', 'addProject'));
      app.append(empty);
      return;
    }

    const layout = el('div', 'layout');
    const projects = el('section', 'projects');
    projects.setAttribute('aria-label', 'Projects and worktrees');
    projects.append(el('h2', '', 'Projects & Worktrees'));
    for (const project of state.projects) {
      const group = el('div', 'project');
      const projectHeader = el('div', 'project-heading');
      projectHeader.append(el('h3', '', project.name), el('span', 'count', `${project.worktrees.length}`));
      group.append(projectHeader);
      if (project.error) group.append(el('p', 'error', project.error));
      for (const worktree of project.worktrees) {
        const card = el('div', `worktree${state.selectedWorktree === worktree.path ? ' selected' : ''}`);
        const branch = el('div', 'branch');
        branch.append(el('span', 'branch-glyph', '⑂'), el('span', 'branch-name', worktree.branch || `detached · ${worktree.head?.slice(0, 7) || ''}`));
        if (!worktree.isMain) branch.append(trashButton('Delete worktree', 'deleteWorktree', { worktreePath: worktree.path }));
        card.append(branch);
        const location = el('div', 'path', worktree.path);
        location.title = worktree.path;
        card.append(location);
        const sessionCount = state.sessions.filter(s => s.worktreePath === worktree.path && s.terminalAttached).length;
        card.append(el('div', 'worktree-meta', worktree.error ? 'Unavailable' : `${worktree.changedFiles || 0} changed file${worktree.changedFiles === 1 ? '' : 's'} · ${sessionCount} terminal${sessionCount === 1 ? '' : 's'}`));
        if (worktree.error) card.append(el('div', 'error', worktree.error));
        else {
          const controls = el('div', 'worktree-actions');
          controls.append(button('+ Session', 'start', { worktreePath: worktree.path }, 'small'),
            button('Changes', 'select', { worktreePath: worktree.path }, 'small secondary'),
            button('In Explorer', 'workspace', { worktreePath: worktree.path }, 'small quiet'));
          card.append(controls);
        }
        group.append(card);
      }
      projects.append(group);
    }

    const sessions = el('section', 'sessions');
    const sessionHeader = el('div', 'section-heading');
    sessionHeader.append(el('h2', '', 'All sessions'));
    const filters = el('div', 'filters');
    filters.setAttribute('aria-label', 'Filter sessions');
    for (const [value, label] of [['all', 'All'], ['live', 'Open'], ['attention', 'Attention']]) {
      const option = el('button', 'filter', label);
      option.type = 'button';
      option.setAttribute('aria-pressed', String(filter === value));
      option.addEventListener('click', () => { filter = value; vscode.setState({ filter }); render(); });
      filters.append(option);
    }
    sessionHeader.append(filters);
    sessions.append(sessionHeader);
    const visible = state.sessions.filter(s => filter === 'all' || filter === 'live' && s.terminalAttached
      || filter === 'attention' && ['blocked', 'done'].includes(s.indicator.state));
    if (!visible.length) {
      const empty = el('div', 'empty');
      empty.append(el('h3', '', state.sessions.length ? 'No matching sessions' : 'No sessions yet'),
        el('p', 'subtle', state.sessions.length ? 'Choose a different filter.' : 'Start a CLI using “+ Session” in the desired worktree.'));
      sessions.append(empty);
    } else {
      for (const session of visible) {
        const row = el('article', 'session');
        const rowHeading = el('div', 'session-heading');
        const name = el('h3', '', session.name);
        const status = el('span', `status ${session.indicator.state}`, session.indicator.label);
        status.title = session.statusLabel;
        rowHeading.append(name, status);
        row.append(rowHeading);
        const meta = el('div', 'session-meta', `${session.projectName} / ${session.branch || 'detached'} · ${session.profileName}`);
        meta.title = session.worktreePath;
        row.append(meta);
        if (session.connected && !session.terminalAttached) row.append(el('div', 'session-meta', 'Running in background'));
        if (session.attention !== 'none') row.append(el('span', `attention ${session.attention}`, session.label));
        const footer = el('div', 'session-footer');
        const created = new Date(session.createdAt);
        const time = el('time', 'subtle', `Started ${created.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`);
        time.dateTime = created.toISOString();
        footer.append(time);
        const controls = el('div', 'actions');
        if (session.connected || session.backend === 'herdr' && session.status === 'detached') controls.append(button('Open terminal', 'terminal', { sessionId: session.id }, 'small secondary'));
        controls.append(button('Mark', 'mark', { sessionId: session.id }, 'small quiet'));
        if (session.connected && ['running', 'unknown'].includes(session.status)) {
          const interrupt = button('Interrupt', 'interrupt', { sessionId: session.id }, 'small quiet');
          interrupt.title = 'Send Ctrl+C to this terminal';
          controls.append(interrupt);
        }
        if (session.connected) controls.append(button('Stop', 'stop', { sessionId: session.id }, 'small quiet'));
        controls.append(trashButton('Delete session', 'deleteSession', { sessionId: session.id }));
        footer.append(controls);
        row.append(footer);
        sessions.append(row);
      }
    }
    sessions.append(el('p', 'footnote', 'Spinner: working · Blue: finished, unread · Hollow dot: idle · Yellow: waiting for input. Open shows attached terminals. Closing a terminal leaves the agent running in the background; reopen it from the Herdr tree or All. The trash action stops and deletes the session.'));
    layout.append(projects, sessions);
    app.append(layout);
  }

  window.addEventListener('message', event => {
    if (event.data?.type !== 'state') return;
    state = event.data.data;
    render();
  });
  render();
  vscode.postMessage({ type: 'ready' });
})();
