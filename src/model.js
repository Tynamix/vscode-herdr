'use strict';

const LABELS = {
  starting: 'Starting', running: 'Session open', unknown: 'Session open · Status unknown',
  exited: 'CLI exited', closed: 'Session ended', detached: 'Disconnected'
};
const ATTENTION = { none: '', input: 'Needs input', review: 'Ready for review' };

function profiles(value) {
  if (!Array.isArray(value)) throw new Error('herdr.agentProfiles must be an array.');
  const seen = new Set();
  return value.map(profile => {
    if (!profile || typeof profile.id !== 'string' || !/^[\w-]+$/.test(profile.id) || typeof profile.name !== 'string' || !profile.name.trim()
      || typeof profile.command !== 'string' || !profile.command.trim() || /[\r\n\0]/.test(profile.command)) {
      throw new Error('Agent profiles need a unique ID, a name and a single-line CLI command.');
    }
    if (seen.has(profile.id)) throw new Error(`Duplicate agent profile ID: ${profile.id}`);
    if (profile.kind !== undefined && (typeof profile.kind !== 'string' || !/^[\w-]+$/.test(profile.kind))) {
      throw new Error('kind must be an agent type supported by herdr.');
    }
    seen.add(profile.id);
    return { id: profile.id, name: profile.name.trim(), command: profile.command.trim(),
      ...(profile.kind === undefined ? {} : { kind: profile.kind }) };
  });
}

function statusLabel(session) {
  const status = LABELS[session.status] || LABELS.unknown;
  const code = session.status === 'exited' && Number.isInteger(session.exitCode) ? ` (${session.exitCode})` : '';
  return `${status}${code}`;
}

function sessionLabel(session) {
  return agentIndicator(session).label;
}

function agentIndicator(session) {
  if (session.attention === 'input') return { state: 'blocked', icon: 'circle-filled', color: 'charts.yellow', label: 'Needs input · manual' };
  if (session.attention === 'review') return { state: 'done', icon: 'circle-filled', color: 'charts.blue', label: 'Ready for review · manual' };
  if (session.agentState === 'blocked') return { state: 'blocked', icon: 'circle-filled', color: 'charts.yellow', label: 'Waiting for input' };
  if (session.agentState === 'working') return { state: 'working', icon: 'loading~spin', label: 'Working' };
  if (session.unreadCompletion) return { state: 'done', icon: 'circle-filled', color: 'charts.blue', label: 'Finished · unread' };
  if (session.agentState === 'idle') return { state: 'idle', icon: 'circle-outline', color: 'descriptionForeground',
    label: session.agentOutcome === 'error' ? 'Error · idle' : session.agentOutcome === 'aborted' ? 'Interrupted · idle' : 'Idle' };
  if (['exited', 'closed', 'detached'].includes(session.status)) return { state: 'idle', icon: 'circle-outline', color: 'descriptionForeground', label: statusLabel(session) };
  return { state: 'unknown', icon: 'circle-outline', color: 'descriptionForeground', label: session.status === 'starting' ? 'Starting' : 'Agent status unknown' };
}

function sortSessions(sessions) {
  const rank = s => ({ blocked: 0, working: 1, done: 2, unknown: 3, idle: 4 })[agentIndicator(s).state];
  return [...sessions].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
}

function restoreSessions(sessions) {
  return sessions.map(session => ['starting', 'running', 'unknown'].includes(session.status)
    ? { ...session, status: 'detached', agentState: 'unknown' } : { ...session });
}

module.exports = { profiles, statusLabel, sessionLabel, agentIndicator, sortSessions, restoreSessions, ATTENTION };
