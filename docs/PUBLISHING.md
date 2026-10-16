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

Updates are published by [`.github/workflows/marketplace.yml`](../.github/workflows/marketplace.yml). After a push/merge to `main`, the workflow runs syntax/manifest checks, unit tests and official VSIX packaging. Only a successful check job can start the separate, serialized publishing job. Pull requests never receive publishing credentials or write permissions. The GUI/backend integration suites still run locally; this hosted workflow does not install herdr or start VS Code.

`semantic-release` determines the next version from commits since the last `v*` release tag, builds one versioned VSIX, publishes that package to Marketplace, and creates a GitHub release with the same VSIX attached. Nothing is published to npm. The existing publisher/extension identity stays unchanged.

### One-time GitHub setup

1. Under **Settings → Actions → General**, enable GitHub Actions and permit the official `actions/*` actions (and `azure/login` if using Entra ID). The workflow requests `contents: write` for publishing tags/releases; organization policy must allow it. No additional GitHub PAT is needed: `GITHUB_TOKEN` is provided automatically.
2. Under **Settings → Environments**, create **`marketplace`**. Restrict deployment branches to **`main`**. Do not require a manual reviewer if releases should happen immediately after merging.
3. Under **Settings → General → Pull Requests**, enable **Squash merging**, and use the **pull request title** as the default squash-commit title. Always keep that title when merging.
4. Protect `main` with a pull-request rule and require **Checks and VSIX**. Changes to this workflow and release scripts should receive the same review as production code. Direct pushes to `main` also trigger publication, so restrict them if you only want releases through merges.
5. Establish the already published **0.1.0** as the release baseline, once, **before the first automatic release**:

   ```sh
   git tag v0.1.0 d9675053a006099dcdbcd77a348f618b0223038e
   git push origin v0.1.0
   ```

   This commit records the initial Marketplace publication, before the new layout/scrolling features. Do not move an existing release tag. The pipeline fails with setup instructions when no release baseline exists, rather than accidentally jumping to 1.0.0.

6. Configure **one** of the authentication methods below. Keep all credentials out of commits, command arguments and chat messages.

### Option A: Publishing token (quick start, temporary)

**Microsoft retires global Azure DevOps PATs on December 1, 2026. This option is a short-term setup, not a permanent authentication solution. Prefer Option B for ongoing automation.** See the [current Microsoft publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token).

1. Open [Azure DevOps](https://dev.azure.com/) with the Microsoft account that can manage the existing **`tynamix`** Marketplace publisher. Create an Azure DevOps organization if you do not have one.
2. Open **User settings → Personal access tokens → New Token**.
3. Name it `vscode-herdr GitHub publishing`, choose **All accessible organizations**, set a short expiration date, and use **Custom defined → Show all scopes → Marketplace → Manage**. Do not grant unrelated scopes.
4. Create the token and copy it once, directly into GitHub: [repository Actions secrets](https://github.com/Tynamix/vscode-herdr/settings/secrets/actions) → **New repository secret**:
   - **Name:** `VSCE_PAT`
   - **Secret:** the Azure DevOps token
5. Leave the `MARKETPLACE_AUTH` Actions variable unset (it defaults to `pat`). The token is verified against the publisher before any release tag is created.

You do **not** need an npm token or a new Marketplace publisher. Renew/revoke the publishing token in Azure DevOps and update the GitHub secret when needed. Switch to Option B before the global PAT retirement.

### Option B: Microsoft Entra ID / GitHub OIDC (long-term, no stored token)

This uses GitHub's short-lived identity token, `azure/login`, and the installed vsce's supported **`--azure-credential`** authentication. It requires access to an Entra tenant with permission to register an application; a tenant administrator may need to help. It does not require storing an Azure client secret in GitHub.

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), open **Applications → App registrations → New registration**. Create a single-tenant application such as `vscode-herdr Marketplace`. Record its **Application (client) ID** and **Directory (tenant) ID**.
2. In that registration, open **Certificates & secrets → Federated credentials → Add credential → GitHub Actions deploying Azure resources**. Configure:
   - Organization: `Tynamix`
   - Repository: `vscode-herdr`
   - Entity type: **Environment**
   - Environment: **`marketplace`**
   - Issuer: `https://token.actions.githubusercontent.com`
   - Subject: `repo:Tynamix/vscode-herdr:environment:marketplace`
   - Audience: `api://AzureADTokenExchange`
3. Under [GitHub Actions variables](https://github.com/Tynamix/vscode-herdr/settings/variables/actions), add these **variables**, not secrets:

   | Name | Value |
   | --- | --- |
   | `MARKETPLACE_AUTH` | `azure` |
   | `AZURE_CLIENT_ID` | Application (client) ID |
   | `AZURE_TENANT_ID` | Directory (tenant) ID |

4. Start **Actions → Marketplace → Run workflow → main**. The Azure sign-in step should succeed. The next step prints only the public Marketplace identity ID using Microsoft's profile endpoint. Copy that ID; the subsequent credential verification may fail until membership is granted.
5. Open [Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/), select **tynamix → Members**, and add this service identity using the printed Marketplace identity/resource ID with the **Contributor** role. Do not use the application-registration object ID in its place. Follow the [Microsoft identity publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace) if your tenant requires administrator approval.
6. Re-run the workflow. Once this works, remove the now-unused `VSCE_PAT` GitHub secret and revoke its Azure DevOps token. Azure mode never falls back to a PAT if identity authentication fails.

### Commit titles and version numbers

| Squash-commit / PR title | Result |
| --- | --- |
| `fix: restore trackpad scrolling` | Patch, for example 0.2.0 → 0.2.1 |
| `perf: reduce terminal rendering work` | Patch |
| `feat: add agent-focused layout` | Minor, for example 0.1.0 → 0.2.0 |
| `feat!: replace the session API` | Major, for example 0.2.0 → 1.0.0 |
| `docs: explain installation`, `chore: update tooling`, `ci: publishing pipeline` | Checks only; no Marketplace release |

A `BREAKING CHANGE:` commit footer also triggers a major release. When several commits are included, the highest required bump wins. The PR check validates the title format. A nonconforming direct commit will not magically count as a feature: keep the Conventional Commit format on `main` too.

Do not manually bump `package.json` for automatic releases. Git tags/GitHub releases are the version source of truth. During release preparation, the CI checkout's `package.json`, lockfile and packaged changelog receive the computed version and release notes; these generated edits are **not committed back to main**. This works with branch protection and avoids recursive release commits. Local development packages retain the source manifest version.

### First run and failure recovery

- Merge a feature with a title such as **`feat: add agent-focused layout and terminal scrolling`** after completing setup. From the v0.1.0 baseline this produces **0.2.0**, not another 0.1.0 upload.
- Watch **Actions → Marketplace → Publish Marketplace release**. Marketplace validation/availability can take additional time after a successful upload. The pipeline has not been tested with live publishing credentials until your first configured run succeeds.
- **Actions → Marketplace → Run workflow → main** retries the normal release flow without requiring an empty commit. If there are no release-worthy commits since the last tag, nothing is published.
- A failed test or credential check prevents publication. The prepared VSIX, if available, is retained as a workflow artifact for 30 days. Credential expiry, publisher membership and GitHub policy errors need to be fixed in their respective services.
- **Partial publication needs explicit recovery.** semantic-release creates its Git tag before publishing to external services. If it fails after that point, a normal rerun can treat the version as already released. Do not delete/move that tag or bump versions blindly. Download that run's exact VSIX artifact, check the Marketplace and GitHub release state, and complete only the missing upload/release for that same version. The [Marketplace publisher dashboard](https://marketplace.visualstudio.com/manage/publishers/) accepts the VSIX as a manual update; if the Marketplace upload already succeeded, only the missing GitHub release/asset needs completing.

Release tooling is development-only and excluded from the VSIX. At setup time, `npm audit` reports an upstream `braces` stack-exhaustion advisory through semantic-release's `micromatch` dependency. No patched upstream version is available in the installed dependency range; do not apply the suggested major downgrade automatically. Release glob/config patterns are repository-controlled, and none of this tooling runs in the installed extension.
