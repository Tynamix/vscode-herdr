'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { git, createWorktree } = require('../src/git');
const { quoteShell } = require('../src/cli-discovery');
const { HerdrBackend } = require('../src/herdr-backend');

async function run(mode) {
  const root = path.resolve(__dirname, '..');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-context-')));
  const web = path.join(directory, 'web');
  const timi = path.join(directory, 'timi');
  const feature = path.join(directory, 'web feature');
  for (const folder of [web, timi]) {
    await fs.mkdir(folder);
    await git(folder, ['init', '-b', 'main']);
    await fs.writeFile(path.join(folder, 'sentinel.txt'), path.basename(folder));
    await git(folder, ['add', '.']);
    await git(folder, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture']);
    await fs.mkdir(path.join(folder, '.vscode'));
    await fs.writeFile(path.join(folder, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Context ' + path.basename(folder), type: 'shell', command: 'pwd' }] }));
  }
  await createWorktree(web, feature, 'feature/test');
  const fixture = path.join(directory, 'pi.mjs');
  await fs.writeFile(fixture, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(path.join(root, 'test', 'fixture-agent.mjs')).href)};\n`, { mode: 0o755 });
  const settings = {
    'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off',
    'window.confirmSaveUntitledWorkspace': false,
    'herdr.agentProfiles': [{ id: 'fixture', name: 'Offline fixture', kind: 'pi', command: quoteShell(fixture) }]
  };
  const workspace = path.join(directory, 'context.code-workspace');
  await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: web }, { path: feature }], settings }));
  if (mode === 'folder') await fs.writeFile(path.join(web, '.vscode', 'settings.json'), JSON.stringify(settings));
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({ phase: 0, checks: [], mode, web, timi, feature }));
  const driver = path.join(directory, 'driver');
  await fs.mkdir(driver);
  await fs.writeFile(path.join(driver, 'package.json'), JSON.stringify({ name: 'herdr-context-driver', publisher: 'local-test', version: '0.0.1',
    engines: { vscode: '^1.93.0' }, main: 'index.js', activationEvents: ['onStartupFinished'], extensionDependencies: ['herdr-workbench.vscode-herdr'] }));
  await fs.writeFile(path.join(driver, 'index.js'), `const vscode = require('vscode');
exports.activate = () => { async function step() {
  try { if (await require(${JSON.stringify(path.join(root, 'test', 'worktree-host.js'))}).run()) return vscode.commands.executeCommand('workbench.action.quit'); }
  catch (error) { console.error(error); return vscode.commands.executeCommand('workbench.action.quit'); }
  setTimeout(step, 1500);
} setTimeout(step, 200); };
`);
  const executable = process.env.VSCODE_EXECUTABLE || '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  const child = spawn(executable, ['--extensionDevelopmentPath=' + root, '--extensionDevelopmentPath=' + driver,
    '--user-data-dir=' + path.join(directory, 'user'), '--extensions-dir=' + path.join(directory, 'extensions'),
    '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--wait', mode === 'folder' ? web : workspace
  ], { env: { ...process.env, HERDR_CONTEXT_RUN: directory }, stdio: 'inherit' });
  let launchError;
  const exited = new Promise(resolve => child.on('exit', resolve));
  child.on('error', error => { launchError = error; });
  // --wait also returns when openFolder replaces the initial folder window.
  // Follow the checkpoint across that transition instead of stopping its
  // still-running backend as soon as the original CLI invocation returns.
  const deadline = Date.now() + 120000;
  let state;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    try { state = JSON.parse(await fs.readFile(path.join(directory, 'state.json'))); } catch { /* Atomic checkpoint in progress. */ }
    if (state?.phase === 99 || state?.error) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (state?.phase === 99 || state?.error) await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  else child.kill();
  if (/^vscode-[a-f0-9]{16}$/.test(state.backendSession || '')) {
    const backend = new HerdrBackend({ directory: path.join(directory, 'cleanup'), sessionName: state.backendSession });
    if (await backend.ensure(false)) await backend.rpc('server.stop');
  }
  console.log(JSON.stringify({ ok: state.phase === 99, mode, checks: state.checks, error: state.error, phase: state.phase, directory }, null, 2));
  if (state.phase !== 99) throw new Error(`Worktree context test failed (${mode}): ${state.error || 'window did not complete'}`);
}

(async () => {
  for (const mode of process.argv[2] ? [process.argv[2]] : ['multi-root', 'folder']) {
    if (!['multi-root', 'folder'].includes(mode)) throw new Error('Unknown workspace test mode');
    await run(mode);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
