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
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
  }

  open(dimensions) {
    if (this.child || this.closed) return;
    const cols = dimensions?.columns || 120;
    const rows = dimensions?.rows || 40;
    this.child = this.backend.control(this.paneId, cols, rows);
    this.child.stdout.setEncoding('utf8');
    let buffer = '';
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return this.finish(new Error('Terminal-Frame ist zu groß.'));
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
    this.child.on('exit', code => this.finish(code ? new Error(errors.trim() || `Terminal-Brücke beendet (${code}).`) : undefined));
    this.timer = setTimeout(() => this.finish(new Error('Terminal-Brücke wurde nicht bereit.')), 12000);
    this.ready.then(() => clearTimeout(this.timer), () => clearTimeout(this.timer));
  }

  send(message) {
    if (this.child?.stdin.writable && !this.closed) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  handleInput(text) { this.send({ type: 'terminal.input', text }); }
  setDimensions(dimensions) {
    if (dimensions.columns > 0 && dimensions.rows > 0) this.send({ type: 'terminal.resize', cols: dimensions.columns, rows: dimensions.rows });
  }

  finish(error) {
    if (this.closed) return;
    this.rejectReady(error || new Error('Terminal wurde getrennt.'));
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
    this.child?.stdin.end();
    // Only the controller is stopped; the server-owned agent keeps running.
    const child = this.child;
    if (child) {
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1000);
      timer.unref?.();
    }
    this.rejectReady(new Error('Terminal wurde getrennt.'));
  }

  dispose() { this.close(); this.writeEmitter.dispose(); this.closeEmitter.dispose(); }
}

module.exports = { HerdrTerminal };
