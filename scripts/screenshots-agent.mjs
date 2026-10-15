// Offline fixture for documentation screenshots. No model or network API calls.
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const handlers = new Map();
let active = false;
const pi = { on: (name, handler) => handlers.set(name, handler), events: { on() {} } };
const context = { isIdle: () => !active, sessionManager: {} };
const extensionIndex = process.argv.indexOf('--extension');
const { default: register } = await import(pathToFileURL(process.argv[extensionIndex + 1]).href);
register(pi);
const emit = async name => handlers.get(name)?.({}, context);
await emit('session_start');
const task = process.argv.find(arg => arg.startsWith('--task='))?.slice(7) || 'checkout';
process.stdout.write('\x1b[2J\x1b[H');
console.log('\x1b[1;36mHERDR WORKBENCH\x1b[0m  ·  Offline demo session');
console.log('');
console.log(task === 'checkout' ? 'Task: Add wallet payments to the checkout flow.'
  : task === 'accessibility' ? 'Task: Review keyboard navigation and focus states.'
    : 'Task: Cover order creation with API tests.');
console.log('');
console.log('  ✓ Read project context and inspected the current branch');
console.log('  ✓ Located the relevant source files and tests');
console.log('');
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
  if (line === 'work') {
    active = true;
    await emit('agent_start');
    console.log('\x1b[36m● Working\x1b[0m  Updating the implementation and checking edge cases…');
  } else if (line === 'block') {
    await emit('ui_prompt_start');
    console.log('\x1b[33m● Input needed\x1b[0m  Keep the existing API response format?');
    console.log('  [y] Keep compatibility    [n] Introduce a new response');
  } else if (line === 'done') {
    active = false;
    await emit('agent_settled');
    console.log('\x1b[32m✓ Turn complete\x1b[0m  Demo changes are ready to review.');
  } else if (line === 'exit') {
    await emit('session_shutdown');
    process.exit(0);
  }
});
