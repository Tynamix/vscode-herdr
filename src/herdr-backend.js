'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { executableDirectories, findExecutable } = require('./cli-discovery');
const execute = promisify(execFile);

function cleanEnvironment(env = process.env) {
  const result = { ...env, PATH: executableDirectories(env).join(path.delimiter) };
  for (const key of Object.keys(result)) {
    if ((key.startsWith('HERDR_') && key !== 'HERDR_CONFIG_PATH') || key.startsWith('VSCODE_')
      || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'NODE_REPL_EXTERNAL_MODULE'].includes(key)) delete result[key];
  }
  return result;
}

function request(socketPath, method, params = {}, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    let buffer = '';
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`herdr is not responding to ${method}.`)), timeout);
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return finish(new Error('herdr response is too large.'));
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.id !== id) continue;
          if (message.error) {
            const error = new Error(message.error.message);
            error.code = message.error.code;
            return finish(error);
          }
          return finish(undefined, message.result);
        } catch (error) { return finish(error); }
      }
    });
  });
}

class HerdrBackend {
  constructor({ directory, sessionName, executable = 'herdr', env = process.env, log = () => {} }) {
    this.directory = directory;
    this.sessionName = sessionName;
    this.executableSetting = executable;
    this.env = { ...cleanEnvironment(env), HERDR_CONFIG_PATH: path.join(directory, 'config.toml') };
    this.log = log;
  }

  async inspect() {
    if (this.inspection) return this.inspection;
    this.inspection = (async () => {
      this.executable = await findExecutable(this.executableSetting, executableDirectories(this.env));
      if (!this.executable) throw new Error('herdr was not found. Install herdr or set herdr.executablePath.');
      const results = await Promise.allSettled([
        this.cli(['--version']), this.cli(['terminal', 'session', 'control', '--help']), this.cli(['agent', 'start', '--help'])
      ]);
      for (const result of results) if (result.status === 'rejected') throw new Error('This herdr build does not support the required terminal bridge: ' + result.reason.message);
      const kinds = /\[possible values:\s*([^\]]+)\]/s.exec(results[2].value)?.[1].split(',').map(value => value.trim());
      if (!kinds?.length) throw new Error('Could not determine the agent types supported by herdr.');
      return { version: results[0].value.trim(), supportedKinds: kinds, executable: this.executable };
    })().catch(error => { this.inspection = undefined; throw error; });
    return this.inspection;
  }

  async cli(args, timeout = 10000) {
    try {
      const { stdout } = await execute(this.executable, ['--session', this.sessionName, ...args], {
        env: this.env, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8'
      });
      return stdout;
    } catch (error) { throw new Error((error.stderr || error.message).trim(), { cause: error }); }
  }

  async locate() {
    await this.inspect();
    const value = JSON.parse(await this.cli(['status', 'server', '--json']));
    this.socketPath = process.platform === 'win32' && !value.socket.startsWith('\\\\.\\pipe\\')
      ? `\\\\.\\pipe\\${value.socket}` : value.socket;
    return value;
  }

  async ensure(start = true) {
    if (this.starting) {
      const running = await this.starting;
      if (running || !start) return running;
    }
    this.starting = (async () => {
      if (this.socketPath) {
        try { await this.rpc('ping', {}, 500); return true; }
        catch { /* Locate the server again if its previous socket is stale. */ }
      }
      const status = await this.locate();
      if (status.running) return true;
      if (!start) return false;
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        await fs.writeFile(this.env.HERDR_CONFIG_PATH,
          '[update]\nversion_check = false\nmanifest_check = false\n\n[experimental]\npane_history = true\n', { flag: 'wx', mode: 0o600 });
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const fd = fsSync.openSync(path.join(this.directory, 'server.log'), 'a', 0o600);
      const child = spawn(this.executable, ['--session', this.sessionName, 'server'], {
        env: this.env, detached: true, stdio: ['ignore', fd, fd]
      });
      fsSync.closeSync(fd);
      child.unref();
      let failure;
      child.on('error', error => { failure = error; });
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        try { await this.rpc('ping', {}, 500); return true; } catch { /* Startup in progress. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`herdr server did not become ready. Log: ${path.join(this.directory, 'server.log')}`);
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  rpc(method, params = {}, timeout) {
    if (!this.socketPath) return Promise.reject(new Error('herdr is not connected.'));
    return request(this.socketPath, method, params, timeout);
  }

  async snapshot() {
    if (!this.socketPath && !await this.ensure(false)) return;
    return (await this.rpc('session.snapshot')).snapshot;
  }

  async create(cwd, label, env = {}) {
    await this.ensure();
    return this.rpc('workspace.create', { cwd, label, env, focus: false });
  }

  async run(paneId, command) {
    await this.cli(['pane', 'run', paneId, command]);
  }

  async focus(paneId) { await this.cli(['agent', 'focus', paneId]).catch(() => {}); }
  async interrupt(paneId) { await this.cli(['pane', 'send-keys', paneId, 'ctrl+c']); }
  async stop(workspaceId) { await this.rpc('workspace.close', { workspace_id: workspaceId }); }

  subscribe(paneIds, onEvent, onDisconnect) {
    if (!paneIds.length || !this.socketPath) return { dispose() {} };
    const socket = net.createConnection(this.socketPath);
    socket.setEncoding('utf8');
    let buffer = '';
    let disposed = false;
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'events', method: 'events.subscribe', params: {
      subscriptions: [...paneIds.map(pane_id => ({ type: 'pane.agent_status_changed', pane_id })),
        { type: 'pane.exited' }, { type: 'pane.closed' }, { type: 'pane.agent_detected' }]
    } }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return socket.destroy();
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.error) { socket.destroy(); break; }
          if (value.event) onEvent(value);
        } catch (error) { this.log(error.message); }
      }
    });
    socket.on('error', error => this.log(error.message));
    socket.on('close', () => { if (!disposed) onDisconnect(); });
    return { dispose() { disposed = true; socket.destroy(); } };
  }

  control(paneId, cols, rows) {
    return spawn(this.executable, ['--session', this.sessionName, 'terminal', 'session', 'control', paneId,
      '--takeover', '--cols', String(cols), '--rows', String(rows)], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
  }
}

module.exports = { HerdrBackend, cleanEnvironment, request };
