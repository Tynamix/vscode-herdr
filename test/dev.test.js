'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { belongsToDevelopmentWindow, developmentUserDataDirectory } = require('../scripts/dev');

test('development profiles use a short, stable path unique to each checkout', () => {
  const home = path.resolve('test-home');
  const checkout = path.resolve('deep', 'checkout'.repeat(30));
  const directory = developmentUserDataDirectory(checkout, home);
  assert.equal(path.dirname(path.dirname(directory)), path.join(home, '.herdr-dev'));
  assert.equal(path.relative(home, directory).length, 32);
  assert.equal(developmentUserDataDirectory(checkout, home), directory);
  assert.notEqual(developmentUserDataDirectory(`${checkout}-other`, home), directory);
});

test('a restarted inspector is accepted only when its process belongs to this development window', async () => {
  const root = path.resolve(__dirname, '..');
  const execute = async (command, args) => ({ stdout: command === 'lsof' ? '42\n' : args[1] === '42'
    ? '7 Code Helper (Plugin)\n' : `1 Code --extensionDevelopmentPath=${root} --user-data-dir=${developmentUserDataDirectory(root)}\n` });
  assert.equal(await belongsToDevelopmentWindow(execute), true);
  assert.equal(await belongsToDevelopmentWindow(async command => ({ stdout: command === 'lsof' ? '42\n' : `1 Code --extensionDevelopmentPath=${root} --user-data-dir=/another/profile\n` })), false);
  assert.equal(await belongsToDevelopmentWindow(async () => { throw new Error('cannot inspect process'); }), false);
});
