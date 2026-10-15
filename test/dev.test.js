'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { belongsToDevelopmentWindow } = require('../scripts/dev');

test('a restarted inspector is accepted only when its process belongs to this development window', async () => {
  const root = path.resolve(__dirname, '..');
  const execute = async (command, args) => ({ stdout: command === 'lsof' ? '42\n' : args[1] === '42'
    ? '7 Code Helper (Plugin)\n' : `1 Code --extensionDevelopmentPath=${root} --user-data-dir=${path.join(root, '.vscode-dev', 'user')}\n` });
  assert.equal(await belongsToDevelopmentWindow(execute), true);
  assert.equal(await belongsToDevelopmentWindow(async command => ({ stdout: command === 'lsof' ? '42\n' : `1 Code --extensionDevelopmentPath=${root} --user-data-dir=/another/profile\n` })), false);
  assert.equal(await belongsToDevelopmentWindow(async () => { throw new Error('cannot inspect process'); }), false);
});
