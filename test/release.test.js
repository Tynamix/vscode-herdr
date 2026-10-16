'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createPlugin, authentication, changelogForRelease } = require('../scripts/marketplace-release');
const config = require('../.releaserc.json');
const execute = promisify(execFile);
const { validTitle } = require('../scripts/check-pr-title');

const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', VSCE_PAT: 'test-only-placeholder' };

test('PR titles preserve the release type when squash-merged, including breaking changes', () => {
  for (const title of ['feat: agent layout', 'fix(terminal): scrolling', 'feat!: new API', 'docs: installation']) assert.equal(validTitle(title), true);
  for (const title of ['', 'New feature', 'feat: ', 'feat:missing space', 'fix\n: scrolling']) assert.equal(validTitle(title), false);
});

async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-release-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const manifest = { name: 'vscode-herdr', publisher: 'tynamix', version: '0.1.0', private: true };
  await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: '0.1.0', lockfileVersion: 3,
    packages: { '': { name: manifest.name, version: '0.1.0' } } }));
  await fs.writeFile(path.join(cwd, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- Pending details.\n\n## 0.1.0\n\nInitial release.\n');
  return { cwd, env: { ...process.env, ...env } };
}

test('Conventional Commits choose patch, minor and major; documentation alone makes no release', async () => {
  const { analyzeCommits } = await import('@semantic-release/commit-analyzer');
  const options = config.plugins[0][1];
  for (const [messages, expected] of [
    [['fix: trackpad scrolling'], 'patch'],
    [['perf: render faster'], 'patch'],
    [['feat(layout): agent view', 'fix: scrolling'], 'minor'],
    [['feat!: change session API'], 'major'],
    [['fix: settings\n\nBREAKING CHANGE: old settings are removed'], 'major'],
    [['docs: describe setup', 'chore: update tooling'], null]
  ]) {
    const result = await analyzeCommits(options, { cwd: path.resolve(__dirname, '..'),
      commits: messages.map(message => ({ message, hash: '1234567' })), logger: { log() {} } });
    assert.equal(result, expected);
  }
  assert.deepEqual(config.branches, ['main']);
  assert.ok(!JSON.stringify(config.plugins).includes('@semantic-release/npm'), 'Never publish this extension to npm');
});

test('authentication fails closed and never falls back from Azure to a stored PAT', () => {
  assert.deepEqual(authentication({ VSCE_PAT: 'placeholder' }), { pat: 'placeholder' });
  assert.throws(() => authentication({}), /Missing VSCE_PAT/);
  assert.throws(() => authentication({ MARKETPLACE_AUTH: 'other' }), /must be pat or azure/);
  assert.throws(() => authentication({ MARKETPLACE_AUTH: 'azure', VSCE_PAT: 'placeholder' }), /AZURE_CLIENT_ID/);
  assert.deepEqual(authentication({ MARKETPLACE_AUTH: 'azure', AZURE_CLIENT_ID: 'id', AZURE_TENANT_ID: 'tenant' }), { azureCredential: true });
});

test('publishing verifies the baseline and publisher credentials without putting secrets in command arguments', async t => {
  const context = await fixture(t);
  const calls = [];
  const plugin = createPlugin({ run: async (...args) => { calls.push(args); return { stdout: 'v0.1.0\n' }; } });
  await plugin.verifyConditions({}, context);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'git');
  assert.ok(calls[1][1].includes('verify-pat'));
  assert.ok(calls[1][1].includes('tynamix'));
  assert.ok(!JSON.stringify(calls.map(call => call.slice(0, 2))).includes(env.VSCE_PAT));
  for (const changes of [{ GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_ACTIONS: '' }]) {
    await assert.rejects(plugin.verifyConditions({}, { ...context, env: { ...env, ...changes } }), /only allowed from main/);
  }
  const noTags = createPlugin({ run: async () => ({ stdout: '' }) });
  await assert.rejects(noTags.verifyConditions({}, context), /baseline tag/);
});

test('release preparation versions manifest and lockfile, adds notes and packages one immutable VSIX', async t => {
  const context = { ...await fixture(t), nextRelease: { version: '0.2.0', gitHead: 'abcdef123', notes: '### Features\n\n* Agent-focused layout' } };
  const calls = [];
  const vsce = {
    async createVSIX(options) {
      calls.push(['package', options]);
      await fs.writeFile(options.packagePath, 'fixture-vsix');
    },
    async publishVSIX(...args) { calls.push(['publish', ...args]); }
  };
  const plugin = createPlugin({ run: execute, loadVsce: () => vsce });
  await plugin.prepare({}, context);
  const manifest = JSON.parse(await fs.readFile(path.join(context.cwd, 'package.json')));
  const lock = JSON.parse(await fs.readFile(path.join(context.cwd, 'package-lock.json')));
  assert.equal(manifest.version, '0.2.0');
  assert.equal(lock.version, '0.2.0');
  assert.equal(lock.packages[''].version, '0.2.0');
  const changelog = await fs.readFile(path.join(context.cwd, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## 0.2.0/);
  assert.match(changelog, /Agent-focused layout/);
  assert.match(changelog, /## 0.1.0/);
  assert.ok(!changelog.includes('Unreleased'));
  assert.ok(!changelog.includes('Pending details'));
  assert.equal(calls[0][1].githubBranch, 'abcdef123');
  assert.equal(calls[0][1].dependencies, false);
  const result = await plugin.publish({}, context);
  assert.equal(calls[1][1], calls[0][1].packagePath);
  assert.deepEqual(calls[1][2], { pat: env.VSCE_PAT });
  assert.equal(result.url, 'https://marketplace.visualstudio.com/items?itemName=tynamix.vscode-herdr');
});

test('changelog generation preserves historical releases, including when no Unreleased heading exists', () => {
  assert.equal(changelogForRelease('# Changelog\n\n## Unreleased\n\nPending only.\n', '0.2.0', 'Notes'), '# Changelog\n\n## 0.2.0\n\nNotes\n\n\n');
  assert.match(changelogForRelease('# Changelog\n\n## 0.1.0\n\nOriginal', '0.2.0', 'Notes'), /## 0.1.0\n\nOriginal/);
});

test('workflow only grants publishing permissions to the main-only job after checks', async () => {
  const workflow = await fs.readFile(path.join(__dirname, '../.github/workflows/marketplace.yml'), 'utf8');
  assert.match(workflow, /needs: checks/);
  assert.match(workflow, /github.event_name != 'pull_request' && github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /environment: marketplace/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /secrets.VSCE_PAT/);
  assert.match(workflow, /vars.MARKETPLACE_AUTH == 'azure'/);
});
