# Documentation screenshots

The README screenshots are captures of the actual extension in a native VS Code development window. The window uses English UI labels, temporary Git repositories and a local offline fixture agent. Agent status travels through the real herdr backend and the Pi status adapter; no model API calls are made.

## Start the demo

```sh
npm run screenshots
```

The launcher prints a temporary directory containing `state.json`, `scene.json`, the demo repositories and an isolated VS Code profile. It opens two projects, five checkouts and three sessions representing work in progress, a request for input and an unread completion. It does not use your existing projects or sessions.

On macOS the default launcher uses the standard VS Code application. `VSCODE_EXECUTABLE` can point to another installed VS Code application executable. The committed captures were taken using VS Code Insiders in a separate development window.

## Choose a scene

Write a new request number and scene name to the printed directory's `scene.json`, for example:

```json
{ "request": 1, "scene": "diff" }
```

Wait until `state.json` reports that scene before capturing the window. Use a new request number for each change.

| Scene | Capture |
| --- | --- |
| `overview` | Dashboard with project/worktree navigation and the three agent states. |
| `diff` | A real TypeScript change in the native side-by-side diff editor. |
| `terminal` | The checkout source and the running session's integrated terminal. |
| `background` | The same session after its terminal is closed, labeled as running in the background. |
| `stop` | Stop and remove all demo sessions, then close the demo window. |

Save clean window captures as `docs/screenshots/session-overview.png`, `native-git-diff.png`, `persistent-terminal.png` and `background-session.png`. Capture the real UI without adding controls or status overlays. Keep notifications and menus closed and make the code, session names and status labels readable.

For macOS capture tools that need the demo in the existing application process, set `HERDR_SCREENSHOTS_PROFILE` to a dedicated profile name and point `VSCODE_EXECUTABLE` to the installed VS Code CLI. The profile is created for the demo; other profiles retain their settings.

The `stop` scene ends the demo agent processes. Its isolated herdr server can then be stopped using the `backendSession` recorded in `state.json`; this namespace belongs only to the demo run. Temporary demo directories are outside the repository and are not included in release packages.
