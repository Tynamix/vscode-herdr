'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HerdrBackend } = require('../src/herdr-backend');
const { findExecutable, quoteShell } = require('../src/cli-discovery');
const { until } = require('./backend-integration');

async function main() {
  const executable = await findExecutable('pi');
  assert.ok(executable, 'This optional integration check requires Pi 1.2+');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-pi-'));
  const backend = new HerdrBackend({ directory, sessionName: `vscode-pitest-${process.pid}` });
  let controller;
  let paneId;
  try {
    const fixture = path.join(directory, 'dialog.mjs');
    await fs.writeFile(fixture, `import fs from 'node:fs';
export default function(pi) {
  pi.on('session_start', () => { fs.writeFileSync(${JSON.stringify(path.join(directory, 'ready'))}, 'ready'); });
  pi.registerCommand('workbench-status-test', { description: 'Offline dialog test', handler: async (_args, ctx) => {
    await ctx.ui.confirm('Workbench-Test', 'Testdialog ohne Modellaufruf');
    fs.writeFileSync(${JSON.stringify(path.join(directory, 'answered'))}, 'answered');
  } });
}
`);
    const created = await backend.create(directory, 'Offline Pi integration test', { PI_CODING_AGENT_DIR: path.join(directory, 'pi-config') });
    paneId = created.root_pane.pane_id;
    const hook = path.join(__dirname, '..', 'integrations', 'pi-status.mjs');
    const args = '--offline --no-mcp --no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes --no-session';
    await backend.run(paneId, `${quoteShell(executable)} ${args} --extension ${quoteShell(hook)} --extension ${quoteShell(fixture)}`);
    controller = backend.control(paneId, 100, 30);
    controller.stdout.resume();
    controller.stderr.resume();
    function input(text) { controller.stdin.write(JSON.stringify({ type: 'terminal.input', text }) + '\n'); }
    async function status(expected) {
      return until(async () => (await backend.snapshot()).agents.some(a => a.pane_id === paneId && a.agent_status === expected), 'Pi status ' + expected);
    }
    await until(async () => { try { await fs.access(path.join(directory, 'ready')); return true; } catch { return false; } }, 'Pi SDK loads both extensions');
    await status('idle');
    input('/workbench-status-test\r');
    await status('blocked');
    input('\r');
    await until(async () => { try { await fs.access(path.join(directory, 'answered')); return true; } catch { return false; } }, 'Pi dialog answered');
    await status('idle');
    console.log(JSON.stringify({ ok: true, checks: ['Installed Pi loads the per-launch addon with isolated configuration', 'Real Pi confirm dialog reports blocked and returns to idle after the answer; no model request'] }, null, 2));
  } catch (error) {
    if (paneId) try { console.error(JSON.stringify(await backend.rpc('pane.read', { pane_id: paneId, source: 'visible' })).slice(0, 5000)); } catch {}
    throw error;
  } finally {
    controller?.stdin.end();
    controller?.kill();
    if (backend.socketPath) await backend.rpc('server.stop').catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
