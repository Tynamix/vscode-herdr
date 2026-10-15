'use strict';

const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const os = require('node:os');

// Canonical commands match herdr's interactive_agent_executable mapping.
const AGENTS = [
  ['pi', 'Pi', 'pi'], ['claude', 'Claude Code', 'claude'], ['codex', 'Codex', 'codex'],
  ['opencode', 'OpenCode', 'opencode'], ['gemini', 'Gemini CLI', 'gemini'],
  ['copilot', 'GitHub Copilot CLI', 'copilot'], ['cursor', 'Cursor Agent', 'cursor-agent'],
  ['devin', 'Devin CLI', 'devin'], ['agy', 'Antigravity CLI', 'agy'], ['cline', 'Cline', 'cline'],
  ['omp', 'OMP', 'omp'], ['mastracode', 'MastraCode', 'mastracode'], ['kimi', 'Kimi Code', 'kimi'],
  ['kiro', 'Kiro CLI', 'kiro-cli'], ['droid', 'Droid', 'droid'], ['amp', 'Amp', 'amp'],
  ['grok', 'Grok CLI', 'grok'], ['hermes', 'Hermes Agent', 'hermes'], ['kilo', 'Kilo Code', 'kilo'],
  ['qodercli', 'Qoder CLI', 'qodercli'], ['qwen', 'Qwen Code', 'qwen'], ['letta', 'Letta Code', 'letta'],
  ['maki', 'Maki', 'maki'], ['muse', 'Muse', 'muse']
].map(([kind, name, executable]) => ({ kind, name, executable }));

function executableDirectories(env = process.env) {
  const home = os.homedir();
  const extra = process.platform === 'win32'
    ? [env.APPDATA && path.join(env.APPDATA, 'npm'), path.join(home, 'scoop', 'shims')]
    : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin')];
  return [...new Set([...(env.PATH || '').split(path.delimiter), ...extra].filter(Boolean))];
}

async function findExecutable(command, directories = executableDirectories()) {
  const candidates = path.isAbsolute(command) ? [command]
    : /[\\/]/.test(command) ? [] : directories.map(directory => path.join(directory, command));
  const suffixes = process.platform === 'win32' && !path.extname(command) ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const candidate of candidates) {
    for (const suffix of suffixes) {
      const file = candidate + suffix;
      try {
        if (!(await fs.stat(file)).isFile()) continue;
        await fs.access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return file;
      } catch { /* Not installed, not executable, or a dangling symlink. */ }
    }
  }
}

function commandExecutable(command) {
  const match = /^\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s'";&|<>`$]+))(?=\s|$)/.exec(command);
  if (!match) return;
  return { executable: match[1] || match[2] || match[3], end: match[0].length };
}

function quoteShell(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid executable path.');
  if (process.platform === 'win32') return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function discoverProfiles({ supportedKinds, profiles = [], directories = executableDirectories() }) {
  const supported = new Set(supportedKinds);
  const available = [];
  const unavailable = [];
  const overrides = new Set(profiles.map(profile => profile.id));
  for (const agent of AGENTS) {
    if (!supported.has(agent.kind) || overrides.has(agent.kind)) continue;
    const executable = await findExecutable(agent.executable, directories);
    if (executable) available.push({ id: agent.kind, kind: agent.kind, name: agent.name,
      executable, command: quoteShell(executable), origin: 'detected' });
  }
  for (const profile of profiles) {
    const parsed = commandExecutable(profile.command);
    const basename = parsed && path.basename(parsed.executable).replace(/\.(cmd|exe|bat)$/i, '');
    const agent = profile.kind ? AGENTS.find(candidate => candidate.kind === profile.kind)
      : AGENTS.find(candidate => candidate.executable === basename);
    const executable = parsed && await findExecutable(parsed.executable, directories);
    if (!agent || !supported.has(agent.kind) || !executable) {
      unavailable.push({ id: profile.id, name: profile.name, reason: !executable ? 'CLI not found' : 'Unsupported by this herdr build' });
      continue;
    }
    available.push({ ...profile, kind: agent.kind, executable, origin: 'configured',
      command: quoteShell(executable) + profile.command.slice(parsed.end) });
  }
  return { available, unavailable };
}

module.exports = { AGENTS, executableDirectories, findExecutable, commandExecutable, quoteShell, discoverProfiles };
