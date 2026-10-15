'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { HerdrBackend } = require('../src/herdr-backend');
const { HerdrTerminal } = require('../src/herdr-terminal');
const { quoteShell } = require('../src/cli-discovery');

async function until(predicate, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + description);
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-backend-'));
  const sessionName = `vscode-test-${process.pid}`;
  const backend = new HerdrBackend({ directory, sessionName });
  const checks = [];
  const bridges = [];
  const errors = [];
  const vscode = { EventEmitter: class {
    constructor() { this.emitter = new EventEmitter(); }
    event = callback => { this.emitter.on('data', callback); return { dispose: () => this.emitter.off('data', callback) }; };
    fire(value) { this.emitter.emit('data', value); }
    dispose() { this.emitter.removeAllListeners(); }
  } };
  let paneId;
  let workspaceId;
  let output = '';
  function attach() {
    const bridge = new HerdrTerminal(vscode, backend, paneId, error => { if (error) errors.push(error.message); });
    bridge.onDidWrite(text => { output = (output + text).slice(-100000); });
    bridges.push(bridge);
    bridge.open({ columns: 90, rows: 25 });
    return bridge;
  }
  async function status(expected) {
    return until(async () => {
      const snapshot = await backend.snapshot();
      const agent = snapshot.agents.find(agent => agent.pane_id === paneId);
      return agent?.agent_status === expected && agent;
    }, 'agent status ' + expected);
  }
  try {
    const info = await backend.inspect();
    assert.ok(info.supportedKinds.includes('pi'));
    await backend.ensure();
    assert.equal((await backend.snapshot()).workspaces.length, 0, 'Dedicated namespace must start empty');
    const created = await backend.create(directory, 'Offline integration fixture');
    paneId = created.root_pane.pane_id;
    workspaceId = created.workspace.workspace_id;
    const fixture = path.join(directory, 'pi');
    const moduleUrl = pathToFileURL(path.join(__dirname, 'fixture-agent.mjs')).href;
    await fs.writeFile(fixture, `#!${process.execPath}\nimport ${JSON.stringify(moduleUrl)};\n`, { mode: 0o755 });
    // .mjs keeps Node's module interpretation independent of the user's config.
    await fs.rename(fixture, fixture + '.mjs');
    const hook = path.join(__dirname, '..', 'integrations', 'pi-status.mjs');
    await backend.run(paneId, `${quoteShell(fixture + '.mjs')} --extension ${quoteShell(hook)}`);
    const first = attach();
    await first.ready;
    await until(() => output.includes('FIXTURE_READY'), 'PTY startup output');
    await status('idle');
    assert.equal(await fs.readFile(path.join(directory, '.herdr-smoke-cwd'), 'utf8'), await fs.realpath(directory));
    checks.push('Isolated headless herdr starts the CLI in the requested directory and renders its PTY');

    first.handleInput('work\r');
    await status('working');
    first.handleInput('block\r');
    await status('blocked');
    first.handleInput('answer\r');
    await status('working');
    first.handleInput('done\r');
    const completed = await status('idle');
    assert.ok(completed.state_change_seq > 0);
    checks.push('Real socket reports idle → working → blocked → working → idle with completion sequence');

    let events = 0;
    const subscription = backend.subscribe([paneId], () => events++, () => {});
    first.close();
    const second = attach();
    await second.ready;
    second.setDimensions({ columns: 110, rows: 30 });
    second.handleInput('work\r');
    await status('working');
    await until(() => events > 0, 'live event subscription');
    assert.equal((await fs.readFile(path.join(directory, '.herdr-smoke-launches'), 'utf8')).trim(), 'launch');
    assert.equal((await backend.snapshot()).workspaces.length, 1);
    subscription.dispose();
    checks.push('Closing/reopening and resizing the terminal preserves the same process; live events arrive');

    second.handleInput('done\r');
    await status('idle');
    await backend.focus(paneId);
    await status('idle');
    checks.push('Opening a completed session acknowledges the unread completion');
    await backend.stop(workspaceId);
    workspaceId = undefined;
    assert.equal((await backend.snapshot()).workspaces.length, 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, backend: info.version, checks }, null, 2));
  } catch (error) {
    try { console.error('AGENTS', JSON.stringify((await backend.snapshot())?.agents)); } catch {}
    if (paneId) {
      try { console.error(JSON.stringify(await backend.rpc('pane.read', { pane_id: paneId, source: 'visible' })).slice(0, 5000)); } catch {}
    }
    throw error;
  } finally {
    for (const bridge of bridges) bridge.dispose();
    if (workspaceId) await backend.stop(workspaceId).catch(() => {});
    if (backend.socketPath) await backend.rpc('server.stop').catch(() => {});
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { until };
