'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const directory of ['src', 'media', 'scripts', 'test', 'integrations']) {
  for (const name of fs.readdirSync(path.join(root, directory))) {
    if (/\.m?js$/.test(name)) execFileSync(process.execPath, ['--check', path.join(root, directory, name)], { stdio: 'inherit' });
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const commands = new Set(manifest.contributes.commands.map(command => command.command));
for (const menu of Object.values(manifest.contributes.menus)) {
  for (const item of menu) if (!commands.has(item.command)) throw new Error(`Unregistered menu command: ${item.command}`);
}
if (!fs.existsSync(path.join(root, manifest.main))) throw new Error('Extension entry point is missing.');
if (manifest.icon && !fs.existsSync(path.join(root, manifest.icon))) throw new Error('Extension icon is missing.');
if (manifest.icon && fs.statSync(path.join(root, manifest.icon)).size > 1024 * 1024) throw new Error('Marketplace icon must not exceed 1024 KB.');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
for (const match of readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)|<img\s[^>]*src="([^"]+)"/g)) {
  const target = match[1] || match[2];
  if (!/^https?:/.test(target) && !fs.existsSync(path.join(root, target))) throw new Error(`README image is missing: ${target}`);
}
console.log('JavaScript syntax and extension manifest OK.');
