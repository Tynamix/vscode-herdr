# Changelog

## Unreleased

- Automatically version and publish Marketplace updates from `main` after checks, with GitHub release assets and PAT or Entra ID authentication.
- Restore the agent-focused layout on session start/open: Herdr left, maximized terminal, terminal list right. Opt out with `herdr.autoArrangeSessions`.
- Forward trackpad/mouse-wheel and page scrolling to the persistent terminal backend, including full-screen agents and normal terminal history.

## 0.1.0 — 2026-10-16

Initial preview of Herdr Workbench for Visual Studio Code.

- Manage multiple Git projects and their existing worktrees in one sidebar.
- Create worktrees from a chosen branch or commit and remove clean linked checkouts.
- Switch Explorer, Git, search, tasks and new terminals to the selected worktree.
- Discover installed agent CLIs and launch persistent sessions through herdr.
- Display working, waiting-for-input and unread-completion states.
- Close and reopen terminal views while the same backend process keeps running.
- Interrupt, stop, mark and delete individual sessions.
- Inspect worktree changes using native VS Code Git views and diff editors.
- Preserve the project catalog, session references and commit-message drafts across workspace switches.
