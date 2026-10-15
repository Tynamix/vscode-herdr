// Offline CLI fixture: exercises the real Pi lifecycle bridge and herdr PTY.
import fs from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const handlers = new Map();
const pi = { on(name, handler) { handlers.set(name, handler); }, events: { on() {} } };
let active = false;
const ctx = { isIdle: () => !active, sessionManager: {} };
const extensionIndex = process.argv.indexOf('--extension');
if (extensionIndex < 0) throw new Error('Missing per-launch Pi integration');
const { default: register } = await import(pathToFileURL(process.argv[extensionIndex + 1]).href);
register(pi);
async function emit(name, event = {}) { await handlers.get(name)?.(event, ctx); }
fs.writeFileSync('.herdr-smoke-cwd', process.cwd());
fs.appendFileSync('.herdr-smoke-launches', 'launch\n');
await emit('session_start', { reason: 'startup' });
console.log('FIXTURE_READY');
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
  if (line === 'work') { active = true; await emit('agent_start'); }
  if (line === 'block') await emit('ui_prompt_start');
  if (line === 'answer') await emit('ui_prompt_end');
  if (line === 'done') { active = false; await emit('agent_settled', { aborted: false }); }
  if (line === 'exit') { await emit('session_shutdown'); process.exit(0); }
  console.log(`FIXTURE_${line.toUpperCase()}`);
});
