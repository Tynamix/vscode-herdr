'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Changes } = require('../src/changes');

test('untrusted workspaces report the trust requirement before looking for Git', async () => {
  const changes = Object.create(Changes.prototype);
  changes.generation = 1;
  changes.vscode = {
    workspace: { isTrusted: false },
    extensions: { getExtension() { assert.fail('Git must not be accessed in an untrusted workspace'); } }
  };
  await assert.rejects(changes.applySelection({ path: '/project' }, 1), /Manage Workspace Trust/);
});

test('trusted workspaces still report a missing built-in Git extension', async () => {
  const changes = Object.create(Changes.prototype);
  changes.generation = 1;
  changes.vscode = {
    workspace: { isTrusted: true },
    extensions: { getExtension: () => undefined }
  };
  await assert.rejects(changes.applySelection({ path: '/project' }, 1), /Git extension is unavailable/);
});
