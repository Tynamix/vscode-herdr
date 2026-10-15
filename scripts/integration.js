'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { HerdrBackend } = require('../src/herdr-backend');
const { quoteShell } = require('../src/cli-discovery');
const { git, createWorktree } = require('../src/git');

async function main() {
  const root = path.resolve(__dirname, '..');
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-integration-'));
  const repository = path.join(run, 'fixture project');
  const linked = path.join(run, 'feature tree');
  await fs.mkdir(repository);
  await git(repository, ['init', '-b', 'main']);
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\nbefore\n';
  await fs.writeFile(path.join(repository, 'example.txt'), before);
  await git(repository, ['add', '.']);
  await git(repository, ['-c', 'user.name=Herdr Test', '-c', 'user.email=herdr@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture']);
  await createWorktree(repository, linked, 'feature/smoke');
  await fs.writeFile(path.join(linked, 'example.txt'), before.replace('before', 'after'));
  const workspaceFile = path.join(run, 'test.code-workspace');
  const fixture = path.join(run, 'pi.mjs');
  await fs.writeFile(fixture, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(path.join(root, 'test', 'fixture-agent.mjs')).href)};\n`, { mode: 0o755 });
  await fs.writeFile(workspaceFile, JSON.stringify({ folders: [{ path: repository }], settings: {
    'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
    'terminal.integrated.enablePersistentSessions': false,
    'herdr.switchWorkspaceOnSelect': false,
    'herdr.agentProfiles': [{ id: 'smoke', kind: 'pi', name: 'Offline fixture', command: quoteShell(fixture) }]
  } }));
  // VS Code deliberately uses in-memory storage with --extensionTestsPath.
  // A temporary driver extension runs these checks in a regular development
  // window instead, so closing/reopening also tests real workspace persistence.
  const driver = path.join(run, 'driver');
  await fs.mkdir(driver);
  await fs.writeFile(path.join(driver, 'package.json'), JSON.stringify({
    name: 'herdr-test-driver', publisher: 'local-test', version: '0.0.1', engines: { vscode: '^1.93.0' },
    main: './index.js', activationEvents: ['onStartupFinished'], extensionDependencies: [`${require('../package.json').publisher}.${require('../package.json').name}`]
  }));
  await fs.writeFile(path.join(driver, 'index.js'), `const vscode = require('vscode');
exports.activate = () => { setTimeout(async () => {
  try { await require(${JSON.stringify(path.join(root, 'test', 'integration-host.js'))}).run(); }
  catch (error) { console.error(error); }
  finally { await vscode.commands.executeCommand('workbench.action.quit'); }
}, 0); };
`);
  const executable = process.env.VSCODE_EXECUTABLE || '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  async function launch(result, restoreId) {
    const child = spawn(executable, [
      '--extensionDevelopmentPath=' + root, '--extensionDevelopmentPath=' + driver,
      '--user-data-dir=' + path.join(run, 'user'), '--extensions-dir=' + path.join(run, 'extensions'),
      '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--wait', workspaceFile
    ], { env: { ...process.env, HERDR_TEST_REPO: repository, HERDR_TEST_TREE: linked, HERDR_TEST_RESULT: result, HERDR_TEST_RESTORE: restoreId || '' }, stdio: 'inherit' });
    const timeout = setTimeout(() => { child.kill(); }, 90000);
    const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timeout);
    try { return JSON.parse(await fs.readFile(result, 'utf8')); }
    catch { throw new Error(`VS Code exited (${exitCode}) without a test result. Test data: ${run}`); }
  }
  const outcome = await launch(path.join(run, 'result.json'));
  try {
    if (outcome.ok && outcome.persistentId) {
      const restored = await launch(path.join(run, 'result-restore.json'), outcome.persistentId);
      outcome.ok = restored.ok;
      outcome.checks.push(...restored.checks);
      if (restored.error) outcome.error = restored.error;
    }
    console.log(JSON.stringify({ ...outcome, testDirectory: run }, null, 2));
  } finally {
    // The VS Code process intentionally leaves its daemon alive. This test owns
    // a fresh random namespace, so only that backend is stopped during cleanup.
    if (/^vscode-[a-f0-9]{16}$/.test(outcome.backendSession || '')) {
      const backend = new HerdrBackend({ directory: path.join(run, 'cleanup'), sessionName: outcome.backendSession });
      if (await backend.ensure(false)) await backend.rpc('server.stop');
    }
  }
  if (!outcome.ok) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
