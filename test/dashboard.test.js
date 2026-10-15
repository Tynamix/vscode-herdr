'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  click() { this.listeners.click?.(); }
}

function dashboard() {
  const app = new Element('main');
  const messages = [];
  let receive;
  let saved = { filter: 'live' };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/dashboard.js'), 'utf8'), {
    acquireVsCodeApi: () => ({
      getState: () => saved, setState: value => { saved = value; }, postMessage: value => messages.push(value)
    }),
    document: { getElementById: () => app, createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag) },
    window: { addEventListener: (_name, callback) => { receive = callback; } }
  });
  const elements = (node = app) => [node, ...node.children.flatMap(child => elements(child))];
  return { messages, elements, send: data => receive({ data: { type: 'state', data } }) };
}

function state(terminalAttached) {
  return {
    projects: [{ name: 'Example', worktrees: [
      { path: '/example', branch: 'main', isMain: true },
      { path: '/example-feature', branch: 'feature', isMain: false }
    ] }],
    sessions: [{ id: 'session-1', name: 'Pi · feature', projectName: 'Example', profileName: 'Pi',
      worktreePath: '/example-feature', branch: 'feature', backend: 'herdr', status: 'running', connected: true,
      terminalAttached, createdAt: 1000, attention: 'none', indicator: { state: 'idle', label: 'Inaktiv' } }]
  };
}

test('open sessions disappear on terminal close and return when the same session is attached again', () => {
  const ui = dashboard();
  const rows = () => ui.elements().filter(element => element.className === 'session');
  ui.send(state(true));
  assert.equal(rows().length, 1);
  ui.send(state(false));
  assert.equal(rows().length, 0);
  assert.ok(ui.elements().some(element => element.textContent?.includes('0 offene CLI-Sessions')));
  ui.elements().find(element => element.textContent === 'Alle').click();
  assert.equal(rows().length, 1);
  assert.ok(ui.elements().some(element => element.textContent === 'Läuft im Hintergrund'));
  ui.elements().find(element => element.textContent === 'Terminal öffnen').click();
  assert.equal(ui.messages.at(-1).type, 'terminal');
  assert.equal(ui.messages.at(-1).sessionId, 'session-1');
  ui.elements().find(element => element.textContent === 'Offene').click();
  ui.send(state(true));
  assert.equal(rows().length, 1);
});

test('accessible trash icons target the selected session or linked worktree and protect the main checkout', () => {
  const ui = dashboard();
  ui.send(state(true));
  const worktreeButtons = ui.elements().filter(element => element.attributes['aria-label'] === 'Worktree löschen');
  assert.equal(worktreeButtons.length, 1);
  worktreeButtons[0].click();
  assert.equal(ui.messages.at(-1).type, 'deleteWorktree');
  assert.equal(ui.messages.at(-1).worktreePath, '/example-feature');
  ui.elements().find(element => element.attributes['aria-label'] === 'Session löschen').click();
  assert.equal(ui.messages.at(-1).type, 'deleteSession');
  assert.equal(ui.messages.at(-1).sessionId, 'session-1');
});
