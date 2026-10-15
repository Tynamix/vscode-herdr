'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { git, createWorktree } = require('../src/git');
const { quoteShell } = require('../src/cli-discovery');
const manifest = require('../package.json');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'herdr-demo-')));
  const folders = Object.fromEntries(['web', 'api', 'checkout', 'accessibility', 'orders'].map(name => [name,
    path.join(directory, { web: 'atlas-web', api: 'atlas-api', checkout: 'checkout', accessibility: 'accessibility', orders: 'orders-api' }[name])]));
  const before = `export type PaymentMethod = 'card';

export interface CheckoutOptions {
  currency: string;
  saveCard: boolean;
}

export const checkoutOptions: CheckoutOptions = {
  currency: 'EUR',
  saveCard: false,
};

export function checkoutSummary(total: number): string {
  return 'Total: ' + total.toFixed(2);
}
`;
  for (const name of ['web', 'api']) {
    await fs.mkdir(path.join(folders[name], 'src'), { recursive: true });
    await git(folders[name], ['init', '-b', 'main']);
    await fs.writeFile(path.join(folders[name], 'src', name === 'web' ? 'checkout.ts' : 'orders.ts'), before);
    await fs.writeFile(path.join(folders[name], 'README.md'), `# Atlas ${name}\n\nLocal documentation demo project.\n`);
    await git(folders[name], ['add', '.']);
    await git(folders[name], ['-c', 'user.name=Herdr Demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initialize demo project']);
  }
  await createWorktree(folders.web, folders.checkout, 'feature/checkout');
  await createWorktree(folders.web, folders.accessibility, 'fix/keyboard-navigation');
  await createWorktree(folders.api, folders.orders, 'feature/order-tests');
  await fs.writeFile(path.join(folders.checkout, 'src/checkout.ts'), before
    .replace("'card';", "'card' | 'wallet';")
    .replace('  saveCard: boolean;', '  saveCard: boolean;\n  paymentMethods: PaymentMethod[];')
    .replace('  saveCard: false,', "  saveCard: false,\n  paymentMethods: ['card', 'wallet'],")
    .replace("  return 'Total: ' + total.toFixed(2);", "  return new Intl.NumberFormat('en-GB', {\n    style: 'currency',\n    currency: checkoutOptions.currency,\n  }).format(total);"));
  const fixture = path.join(directory, 'pi');
  await fs.writeFile(fixture, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/screenshots-agent.mjs')).href)};\n`, { mode: 0o755 });
  const workspace = path.join(directory, 'Herdr Demo.code-workspace');
  await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: folders.checkout, name: 'Atlas Web · feature/checkout' }], settings: {
    'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'window.zoomLevel': 0,
    'window.title': 'Herdr Workbench · Documentation Demo', 'workbench.colorTheme': 'Default Dark Modern',
    'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.editor.enablePreview': false,
    'editor.fontSize': 14, 'editor.minimap.enabled': false, 'editor.stickyScroll.enabled': false,
    'editor.accessibilitySupport': 'on',
    'breadcrumbs.enabled': false, 'terminal.integrated.fontSize': 13, 'git.autofetch': false,
    'herdr.switchWorkspaceOnSelect': false, 'herdr.agentProfiles': [
      ['checkout', 'Checkout agent'], ['accessibility', 'Accessibility review'], ['orders', 'API test agent']
    ].map(([task, name]) => ({ id: `demo-${task}`, name, kind: 'pi', command: quoteShell(fixture) + ` --task=${task}` }))
  } }, null, 2));
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(folders, null, 2));
  await fs.writeFile(path.join(directory, 'scene.json'), JSON.stringify({ request: 0, scene: 'overview' }));
  const driver = path.join(directory, 'driver');
  await fs.mkdir(driver);
  await fs.writeFile(path.join(driver, 'package.json'), JSON.stringify({ name: 'herdr-screenshots-driver', publisher: 'local-demo',
    version: '0.0.1', engines: { vscode: '^1.93.0' }, main: 'index.js', activationEvents: ['onStartupFinished'],
    extensionDependencies: [`${manifest.publisher}.${manifest.name}`] }));
  await fs.writeFile(path.join(driver, 'index.js'), `exports.activate = () => require(${JSON.stringify(path.join(root, 'scripts/screenshots-host.js'))}).activate();\n`);
  const env = { ...process.env, HERDR_SCREENSHOTS_RUN: directory };
  for (const key of Object.keys(env)) if (key.startsWith('VSCODE_') || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE'].includes(key)) delete env[key];
  const executable = process.env.VSCODE_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : 'code');
  const profileArgs = process.env.HERDR_SCREENSHOTS_PROFILE
    ? ['--profile=' + process.env.HERDR_SCREENSHOTS_PROFILE]
    : ['--user-data-dir=' + path.join(directory, 'user'), '--extensions-dir=' + path.join(directory, 'extensions')];
  const log = await fs.open(path.join(directory, 'vscode.log'), 'a');
  const child = spawn(executable, ['--new-window', '--extensionDevelopmentPath=' + root, '--extensionDevelopmentPath=' + driver,
    ...profileArgs,
    '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--locale=en', '--force-renderer-accessibility', workspace],
  { env, detached: true, stdio: ['ignore', log.fd, log.fd] });
  child.unref();
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  await log.close();
  console.log(directory);
  console.log('Native VS Code demo starting. Read state.json for readiness; write scene.json to select overview, diff, terminal, background or stop.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
