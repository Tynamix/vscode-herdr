'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HerdrBackend } = require('../src/herdr-backend');

test('an existing responsive socket is verified without spawning a server-discovery CLI', async () => {
  const backend = Object.create(HerdrBackend.prototype);
  backend.socketPath = '/existing/socket';
  const calls = [];
  backend.rpc = async (...args) => { calls.push(args); };
  backend.locate = () => assert.fail('A responsive socket needs no CLI discovery');
  assert.equal(await backend.ensure(), true);
  assert.equal(await backend.ensure(false), true);
  assert.deepEqual(calls, [['ping', {}, 500], ['ping', {}, 500]]);
});

test('a stale socket falls back to server discovery and reconnects to its current socket', async () => {
  const backend = Object.create(HerdrBackend.prototype);
  backend.socketPath = '/stale/socket';
  const calls = [];
  backend.rpc = async () => { calls.push('ping'); throw new Error('Socket closed'); };
  backend.locate = async () => {
    calls.push('locate');
    backend.socketPath = '/new/socket';
    return { running: true };
  };
  assert.equal(await backend.ensure(), true);
  assert.equal(backend.socketPath, '/new/socket');
  assert.deepEqual(calls, ['ping', 'locate']);
});

test('server discovery remains necessary without a known socket and does not start an unwanted server', async () => {
  const backend = Object.create(HerdrBackend.prototype);
  backend.rpc = () => assert.fail('No socket is known yet');
  backend.locate = async () => ({ running: true });
  assert.equal(await backend.ensure(), true);
  backend.locate = async () => ({ running: false });
  assert.equal(await backend.ensure(false), false);
});

test('concurrent connection checks share one ping', async () => {
  const backend = Object.create(HerdrBackend.prototype);
  backend.socketPath = '/existing/socket';
  let release;
  let pings = 0;
  backend.rpc = () => { pings++; return new Promise(resolve => { release = resolve; }); };
  const first = backend.ensure();
  const second = backend.ensure();
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(pings, 1);
  assert.equal(backend.starting, undefined);
});

test('failed discovery is surfaced and can be retried after a stale socket', async () => {
  const backend = Object.create(HerdrBackend.prototype);
  backend.socketPath = '/stale/socket';
  backend.rpc = async () => { throw new Error('Socket closed'); };
  backend.locate = async () => { throw new Error('Discovery failed'); };
  await assert.rejects(backend.ensure(), /Discovery failed/);
  assert.equal(backend.starting, undefined);
  backend.locate = async () => ({ running: false });
  assert.equal(await backend.ensure(false), false);
});
