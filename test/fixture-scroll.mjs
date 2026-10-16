// Offline terminal fixture: normal-screen history, then a mouse-aware TUI.
import fs from 'node:fs';

process.stdin.setRawMode(true);
process.stdin.resume();
for (let i = 0; i < 100; i++) console.log(`SCROLL_HISTORY_${String(i).padStart(3, '0')}`);
console.log('SCROLL_HISTORY_READY');
let tui = false;
process.stdin.on('data', data => {
  if (!tui && data.toString() === 't') {
    tui = true;
    process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[HTUI_SCROLL_READY');
    return;
  }
  fs.appendFileSync('.herdr-scroll-input', data.toString('hex') + '\n');
});
