'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { HerdrTerminal } = require('../src/herdr-terminal');

function fixture(t) {
  const messages = [];
  const writes = [];
  const vscode = { EventEmitter: class {
    constructor() { this.emitter = new EventEmitter(); }
    event = callback => { this.emitter.on('data', callback); return { dispose() {} }; };
    fire(data) { this.emitter.emit('data', data); }
    dispose() { this.emitter.removeAllListeners(); }
  } };
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: { writable: true, write(line) { messages.push(JSON.parse(line)); }, end() {} }, exitCode: 0 });
  const terminal = new HerdrTerminal(vscode, { control: () => child }, 'pane', () => {});
  terminal.onDidWrite(text => writes.push(text));
  terminal.open({ columns: 100, rows: 25 });
  child.stdout.write(JSON.stringify({ type: 'terminal.frame', encoding: 'ansi', bytes: Buffer.from('ready').toString('base64') }) + '\n');
  t.after(() => terminal.dispose());
  return { terminal, messages, writes };
}

test('renderer enables SGR mouse input and translates trackpad wheel reports to backend scrolling', t => {
  const { terminal, messages, writes } = fixture(t);
  assert.match(writes[0], /\x1b\[\?1000h\x1b\[\?1006h/);
  terminal.handleInput('\x1b[<64;10;5M\x1b[<65;11;6M');
  assert.deepEqual(messages, [
    { type: 'terminal.scroll', direction: 'up', source: 'wheel', lines: 3, column: 9, row: 4, modifiers: 0 },
    { type: 'terminal.scroll', direction: 'down', source: 'wheel', lines: 3, column: 10, row: 5, modifiers: 0 }
  ]);
  terminal.handleInput('\x1b[<92;1;1M'); // Shift + Alt + Ctrl wheel up.
  assert.equal(messages.at(-1).modifiers, 7);
});

test('page keys use semantic scrolling and the current viewport height', t => {
  const { terminal, messages } = fixture(t);
  terminal.handleInput('\x1b[5~');
  assert.deepEqual(messages.at(-1), { type: 'terminal.scroll', direction: 'up', source: 'page_key', lines: 24 });
  terminal.setDimensions({ columns: 120, rows: 40 });
  terminal.handleInput('\x1b[6~');
  assert.deepEqual(messages.at(-1), { type: 'terminal.scroll', direction: 'down', source: 'page_key', lines: 39 });
});

test('fragmented reports are routed, ordinary input is preserved and click reports never enter the prompt', t => {
  const { terminal, messages } = fixture(t);
  for (const text of ['hello', '\x1b[', '<64;2;', '3M', '\x1b[A', '\x1b[<0;4;5M', '\x1b[<0;4;5m', 'world']) terminal.handleInput(text);
  assert.deepEqual(messages, [
    { type: 'terminal.input', text: 'hello' },
    { type: 'terminal.scroll', direction: 'up', source: 'wheel', lines: 3, column: 1, row: 2, modifiers: 0 },
    { type: 'terminal.input', text: '\x1b[A' },
    { type: 'terminal.input', text: 'world' }
  ]);
});

test('bracketed paste remains one input packet and never triggers scroll routing', t => {
  const { terminal, messages } = fixture(t);
  const text = '\x1b[200~pasted\x1b[5~\x1b[<64;1;1M\x1b[201~';
  for (const character of text) terminal.handleInput(character);
  assert.deepEqual(messages, [{ type: 'terminal.input', text }]);
});

test('standalone Escape is delivered and disposing cancels pending input', async t => {
  const { terminal, messages } = fixture(t);
  terminal.handleInput('\x1b');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(messages, [{ type: 'terminal.input', text: '\x1b' }]);
  terminal.handleInput('\x1b[');
  terminal.dispose();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(messages.at(-1), { type: 'terminal.release' });
});
