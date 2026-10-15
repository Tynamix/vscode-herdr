# Publishing Herdr Workbench

Version **0.1.0** was published on **2026-10-16** under the `tynamix` publisher. The [public Marketplace listing](https://marketplace.visualstudio.com/items?itemName=tynamix.vscode-herdr) includes the English README, four documentation screenshots and the final terminal-H icon.

## Release identity

| Field | Value |
| --- | --- |
| Product name | Herdr Workbench |
| Marketplace display name | Herdr Workbench — Git Worktrees & CLI Agents |
| Publisher ID | `tynamix` (Tynamix) |
| Extension name | `vscode-herdr` |
| Extension ID | `tynamix.vscode-herdr` |
| Initial version | `0.1.0`, marked as a preview |
| License | MIT |
| Source | https://github.com/Tynamix/vscode-herdr |

The `publisher` value in `package.json` must match the registered Marketplace publisher ID. If the proposed ID is unavailable, choose the actual ID before packaging. The test drivers derive the extension ID from the manifest.

## Prepare the package

```sh
npm ci
npm run check
npm test
npm run package:marketplace
```

Upload **`dist/herdr-workbench-marketplace.vsix`**. This package is produced by Microsoft's official `@vscode/vsce` tool. It includes the production code, final icon, MIT license, README, changelog, support instructions and documentation screenshots. Development profiles, demo scripts, tests, design drafts and development dependencies are excluded.

The Marketplace icon is the 256 × 256 PNG at `media/herdr-marketplace-icon.png`. Keep it below the Marketplace's 1024 KB limit; `npm run check` verifies that limit. The larger approved artwork is retained separately for future exports.

`npm run package` remains an offline packager for local installation. Use the package produced by `package:marketplace` for publication.

## First publication through the browser

1. Sign in at [Manage Publishers & Extensions](https://marketplace.visualstudio.com/manage/publishers/).
2. Create the publisher using **Tynamix** as the display name and **tynamix** as the ID, if available. Review the Publisher Agreement at the registration step.
3. Publish the release source and screenshots to the repository's `main` branch. The Marketplace package rewrites README images to public HTTPS URLs in that repository, so the files must be accessible there.
4. In the publisher dashboard, choose **New extension → Visual Studio Code** and select `dist/herdr-workbench-marketplace.vsix`.
5. Review the extracted name, version, description and icon, then submit the extension for publication.
6. Wait for validation and check the resulting listing. Confirm that screenshots load, the source/support/license links work, and the extension can be installed from VS Code.

The public listing is [tynamix.vscode-herdr](https://marketplace.visualstudio.com/items?itemName=tynamix.vscode-herdr).

Browser upload supports an initial release without configuring CLI publishing credentials. Microsoft's [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) covers publisher registration, manual uploads and automated publishing.

## Updates

Increase the version in `package.json`, add its changes to `CHANGELOG.md`, run the checks and create a fresh Marketplace package. Upload it as an update to the existing extension. Keep the publisher and extension name stable so existing installations receive updates.
