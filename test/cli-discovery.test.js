'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { discoverProfiles, commandExecutable, quoteShell, findExecutable } = require('../src/cli-discovery');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('offers only executable supported CLIs, including the cursor-agent mapping, without running them', async t => {
  const directory = await fixture(t);
  const marker = path.join(directory, 'executed');
  for (const name of ['pi', 'codex', 'cursor-agent', 'unknown']) {
    await fs.writeFile(path.join(directory, name), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  }
  await fs.writeFile(path.join(directory, 'claude'), 'not executable', { mode: 0o644 });
  await fs.symlink(path.join(directory, 'missing'), path.join(directory, 'gemini'));
  const result = await discoverProfiles({ supportedKinds: ['pi', 'claude', 'cursor', 'gemini'], directories: [directory] });
  assert.deepEqual(result.available.map(p => p.id), ['pi', 'cursor']);
  await assert.rejects(fs.access(marker));
});

test('configured profiles resolve quoted paths, preserve arguments and override matching defaults', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'my pi');
  await fs.writeFile(file, '#!/bin/sh\n', { mode: 0o755 });
  await fs.writeFile(path.join(directory, 'pi'), '#!/bin/sh\n', { mode: 0o755 });
  const profile = { id: 'pi', name: 'Pi offline', kind: 'pi', command: `"${file}" --offline --no-session` };
  const result = await discoverProfiles({ supportedKinds: ['pi'], profiles: [profile], directories: [directory] });
  assert.equal(result.available.length, 1);
  assert.equal(result.available[0].command, quoteShell(file) + ' --offline --no-session');
  assert.equal(result.available[0].origin, 'configured');
  assert.equal(result.available[0].kind, 'pi');
});

test('missing configured commands, shell aliases and unsupported agent kinds are excluded', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const result = await discoverProfiles({ supportedKinds: ['pi'], directories: [directory], profiles: [
    { id: 'missing', name: 'Missing', command: 'my-alias', kind: 'pi' },
    { id: 'unsupported', name: 'Unsupported', command: 'claude', kind: 'claude' },
    { id: 'invalid-kind', name: 'Invalid', command: 'claude', kind: 'not-real' },
    { id: 'shell', name: 'Shell expression', command: 'MY_VAR=1 pi', kind: 'pi' }
  ] });
  assert.equal(result.available.length, 0);
  assert.equal(result.unavailable.length, 4);
  assert.equal(await findExecutable('my-alias', [directory]), undefined);
  assert.equal(commandExecutable('$(unsafe) pi'), undefined);
});
