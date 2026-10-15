'use strict';

// Launch normally before attaching the debugger. Starting the utility extension
// host in inspect-break mode crashes on some VS Code / Electron installations.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const root = path.resolve(__dirname, '..');
const directory = path.join(root, '.vscode-dev');
const port = 9333;
const targetFile = path.join(directory, 'debug-target.json');

async function belongsToDevelopmentWindow(execute = promisify(execFile)) {
  try {
    const { stdout } = await execute('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    for (const listener of new Set(stdout.trim().split(/\s+/))) {
      let pid = listener;
      for (let depth = 0; /^\d+$/.test(pid) && Number(pid) > 1 && depth < 16; depth++) {
        const { stdout: processInfo } = await execute('ps', ['-p', pid, '-o', 'ppid=', '-o', 'command=']);
        const match = /^\s*(\d+)\s+([^\n]+)$/.exec(processInfo.trim());
        if (!match) break;
        if (match[2].includes(`--user-data-dir=${path.join(directory, 'user')}`)
          && match[2].includes(`--extensionDevelopmentPath=${root}`)) return true;
        pid = match[1];
      }
    }
  } catch { /* Never attach to an unverified listener. */ }
  return false;
}

function inspector() {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/json/list', timeout: 500 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const target = JSON.parse(body).find(item => item.type === 'node' && item.id && item.webSocketDebuggerUrl);
          if (!target) throw new Error('Kein Node-Inspector erreichbar.');
          resolve(target);
        } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Inspector antwortet nicht.')));
    request.on('error', reject);
  });
}

async function checkPort() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${port} ist bereits durch einen anderen Prozess belegt. Es wird kein fremder Prozess beendet oder verbunden.`)));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}

async function main() {
  await fs.mkdir(directory, { recursive: true });
  let saved;
  try { saved = JSON.parse(await fs.readFile(targetFile, 'utf8')); } catch { /* First launch. */ }
  let existing;
  try { existing = await inspector(); } catch { /* Port may be free. */ }
  if (existing) {
    if (saved?.root !== root || saved?.id !== existing.id && !await belongsToDevelopmentWindow()) {
      throw new Error(`Port ${port} gehört nicht zu diesem Herdr-Entwicklungsfenster. Bitte einen anderen Debug-Prozess zuerst beenden.`);
    }
    if (saved.id !== existing.id) await fs.writeFile(targetFile, JSON.stringify({ root, id: existing.id }, null, 2) + '\n');
    console.log(`Herdr-Entwicklungsfenster läuft bereits. Debugger kann sich auf Port ${port} verbinden.`);
    return;
  }
  await checkPort();

  const executable = process.argv[2] || process.env.VSCODE_EXECUTABLE
    || (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : 'code');
  const workspace = path.join(directory, 'herdr.code-workspace');
  try { await fs.access(workspace); }
  catch {
    await fs.writeFile(workspace, JSON.stringify({ folders: [], settings: { 'workbench.startupEditor': 'none' } }, null, 2) + '\n');
  }
  const env = { ...process.env };
  // Do not inject the launcher's debugger bootstrap or its VS Code IPC context
  // into the separate application. Keep the user's normal shell environment.
  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_') || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE'].includes(key)) delete env[key];
  }
  console.log('Herdr-Entwicklungsfenster wird gestartet …');
  const child = spawn(executable, [
    '--new-window', `--extensionDevelopmentPath=${root}`,
    `--user-data-dir=${path.join(directory, 'user')}`,
    `--extensions-dir=${path.join(directory, 'extensions')}`,
    '--disable-extensions', `--inspect-extensions=${port}`, workspace
  ], { env, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  child.unref();
  let launchError;
  child.on('error', error => { launchError = error; });
  child.on('exit', code => {
    if (code && !launchError) launchError = new Error(`VS Code wurde beim Start mit Exit-Code ${code} beendet.`);
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    try {
      const target = await inspector();
      await fs.writeFile(targetFile, JSON.stringify({ root, id: target.id }, null, 2) + '\n');
      console.log(`Herdr ist bereit. Debugger kann sich auf Port ${port} verbinden.`);
      return;
    } catch { /* The GUI and its extension host are still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Der Extension-Host wurde auf Port ${port} nicht bereit. Logs: ${path.join(directory, 'user', 'logs')}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { belongsToDevelopmentWindow };
