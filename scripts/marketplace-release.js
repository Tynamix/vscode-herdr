'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

function authentication(env) {
  const mode = env.MARKETPLACE_AUTH || 'pat';
  if (mode === 'azure') {
    if (!env.AZURE_CLIENT_ID || !env.AZURE_TENANT_ID) throw new Error('Azure publishing needs AZURE_CLIENT_ID and AZURE_TENANT_ID variables. See docs/PUBLISHING.md.');
    return { azureCredential: true };
  }
  if (mode !== 'pat') throw new Error('MARKETPLACE_AUTH must be pat or azure.');
  if (!env.VSCE_PAT) throw new Error('Missing VSCE_PAT GitHub Actions secret. See docs/PUBLISHING.md.');
  return { pat: env.VSCE_PAT };
}

function changelogForRelease(changelog, version, notes) {
  // Release notes are generated from commits; don't ship an outdated Unreleased
  // section alongside them. Only the CI checkout changes, never main itself.
  let history = changelog.replace(/^# Changelog\s*/, '').trim();
  if (/^## Unreleased(?:\r?\n|$)/.test(history)) {
    const end = history.indexOf('\n## ', 1);
    history = end === -1 ? '' : history.slice(end + 1);
  }
  return `# Changelog\n\n## ${version}\n\n${notes.trim()}\n\n${history}\n`;
}

function createPlugin({ run = execute, loadVsce = () => require('@vscode/vsce') } = {}) {
  return {
    async verifyConditions(_config, { cwd, env }) {
      if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main'
        || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
        throw new Error('Marketplace releases are only allowed from main in GitHub Actions.');
      }
      const auth = authentication(env);
      const manifest = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
      // Never let semantic-release silently start at 1.0.0 for this existing
      // 0.1.0 extension. Establish the historical release tag once during setup.
      const { stdout } = await run('git', ['tag', '--merged', 'HEAD', '--list', 'v[0-9]*'], { cwd, env });
      if (!stdout.split(/\s+/).some(tag => /^v\d+\.\d+\.\d+$/.test(tag))) {
        throw new Error('Missing release baseline tag v0.1.0. Follow the one-time setup in docs/PUBLISHING.md before publishing.');
      }
      const cli = require.resolve('@vscode/vsce/vsce');
      const args = [cli, 'verify-pat', manifest.publisher];
      if (auth.azureCredential) args.push('--azure-credential');
      // Credentials are passed only in the environment, never command args.
      await run(process.execPath, args, { cwd, env });
    },

    async prepare(_config, { cwd, env, nextRelease }) {
      const version = nextRelease.version;
      await run('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts'], { cwd, env });
      const file = path.join(cwd, 'CHANGELOG.md');
      const changelog = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, changelogForRelease(changelog, version, nextRelease.notes));
      await fs.mkdir(path.join(cwd, 'dist'), { recursive: true });
      await loadVsce().createVSIX({ cwd, packagePath: path.join(cwd, 'dist/herdr-workbench-marketplace.vsix'),
        dependencies: false, githubBranch: nextRelease.gitHead });
    },

    async publish(_config, { cwd, env }) {
      const manifest = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
      // Publish the prepared package, not another build. Do not silently skip a
      // duplicate version: partial failures need explicit recovery/review.
      await loadVsce().publishVSIX(path.join(cwd, 'dist/herdr-workbench-marketplace.vsix'), authentication(env));
      return { name: 'Visual Studio Marketplace', url: `https://marketplace.visualstudio.com/items?itemName=${manifest.publisher}.${manifest.name}` };
    }
  };
}

module.exports = { ...createPlugin(), createPlugin, authentication, changelogForRelease };
