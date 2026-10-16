'use strict';

class HerdrTerminal {
  constructor(vscode, backend, paneId, disconnected) {
    this.backend = backend;
    this.paneId = paneId;
    this.disconnected = disconnected;
    this.writeEmitter = new vscode.EventEmitter();
    this.closeEmitter = new vscode.EventEmitter();
    this.onDidWrite = this.writeEmitter.event;
    this.onDidClose = this.closeEmitter.event;
    this.inputBuffer = '';
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
  }

  open(dimensions) {
    if (this.child || this.closed) return;
    const cols = dimensions?.columns || 120;
    const rows = dimensions?.rows || 40;
    this.rows = rows;
    // The backend streams rendered cells, not the agent's terminal modes.
    // Request SGR mouse reports here so xterm sends wheel/trackpad events to
    // handleInput. Bracketed paste keeps pasted escape sequences out of routing.
    this.writeEmitter.fire('\x1b[?1000h\x1b[?1006h\x1b[?2004h');
    this.child = this.backend.control(this.paneId, cols, rows);
    this.child.stdin.on?.('error', error => this.finish(error));
    this.child.stdout.setEncoding('utf8');
    let buffer = '';
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return this.finish(new Error('Terminal frame is too large.'));
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === 'terminal.frame' && message.encoding === 'ansi' && typeof message.bytes === 'string') {
            this.resolveReady();
            this.writeEmitter.fire(Buffer.from(message.bytes, 'base64').toString('utf8'));
          } else if (message.type === 'terminal.closed') this.finish();
        } catch (error) { this.finish(error); }
      }
    });
    let errors = '';
    this.child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-4000); });
    this.child.on('error', error => this.finish(error));
    this.child.on('exit', code => this.finish(code ? new Error(errors.trim() || `Terminal bridge exited (${code}).`) : undefined));
    this.timer = setTimeout(() => this.finish(new Error('Terminal bridge did not become ready.')), 12000);
    this.ready.then(() => clearTimeout(this.timer), () => clearTimeout(this.timer));
  }

  send(message) {
    if (this.child?.stdin.writable && !this.child.stdin.destroyed && !this.closed) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  handleInput(text) {
    if (this.closed) return;
    clearTimeout(this.inputTimer);
    this.inputBuffer += text;
    while (this.inputBuffer) {
      if (this.inputBuffer.startsWith('\x1b[200~')) {
        const end = this.inputBuffer.indexOf('\x1b[201~', 6);
        if (end === -1) return; // Keep a paste intact, including split packets.
        this.send({ type: 'terminal.input', text: this.inputBuffer.slice(0, end + 6) });
        this.inputBuffer = this.inputBuffer.slice(end + 6);
        continue;
      }
      const escape = this.inputBuffer.indexOf('\x1b');
      if (escape !== 0) {
        const end = escape === -1 ? this.inputBuffer.length : escape;
        this.send({ type: 'terminal.input', text: this.inputBuffer.slice(0, end) });
        this.inputBuffer = this.inputBuffer.slice(end);
        continue;
      }
      const sequence = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.inputBuffer)?.[0];
      if (!sequence && /^\x1b(?:\[[0-?]*[ -/]*)?$/.test(this.inputBuffer)) {
        // Don't swallow a standalone Escape, but allow fragmented CSI reports.
        this.inputTimer = setTimeout(() => {
          this.send({ type: 'terminal.input', text: this.inputBuffer });
          this.inputBuffer = '';
        }, 30);
        return;
      }
      const input = sequence || this.inputBuffer[0];
      this.inputBuffer = this.inputBuffer.slice(input.length);
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input);
      if (mouse) {
        const button = Number(mouse[1]);
        if (mouse[4] === 'M' && [64, 65].includes(button & ~28)) {
          this.scroll(button & 1 ? 'down' : 'up', 'wheel', {
            column: Math.max(0, Number(mouse[2]) - 1), row: Math.max(0, Number(mouse[3]) - 1),
            modifiers: (button & 4 ? 1 : 0) | (button & 8 ? 2 : 0) | (button & 16 ? 4 : 0)
          });
        }
        // The control protocol supports semantic scrolling, but not mouse
        // clicks. Never leak synthetic click reports into a shell or prompt.
      } else if (input === '\x1b[5~' || input === '\x1b[6~') {
        this.scroll(input === '\x1b[5~' ? 'up' : 'down');
      } else this.send({ type: 'terminal.input', text: input });
    }
  }

  scroll(direction, source = 'page_key', position = {}) {
    this.send({ type: 'terminal.scroll', direction, source,
      lines: source === 'wheel' ? 3 : Math.max(1, (this.rows || 40) - 1), ...position });
  }

  setDimensions(dimensions) {
    if (dimensions.columns > 0 && dimensions.rows > 0) {
      this.rows = dimensions.rows;
      this.send({ type: 'terminal.resize', cols: dimensions.columns, rows: dimensions.rows });
    }
  }

  finish(error) {
    if (this.closed) return;
    this.rejectReady(error || new Error('Terminal was disconnected.'));
    if (error) this.writeEmitter.fire(`\r\n${error.message}\r\n`);
    this.close();
    this.disconnected(error);
    this.closeEmitter.fire(error ? 1 : 0);
  }

  close() {
    if (this.closed) return;
    this.send({ type: 'terminal.release' });
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.inputTimer);
    this.inputBuffer = '';
    this.child?.stdin.end();
    // Only the controller is stopped; the server-owned agent keeps running.
    const child = this.child;
    if (child) {
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1000);
      timer.unref?.();
    }
    this.rejectReady(new Error('Terminal was disconnected.'));
  }

  dispose() { this.close(); this.writeEmitter.dispose(); this.closeEmitter.dispose(); }
}

module.exports = { HerdrTerminal };
