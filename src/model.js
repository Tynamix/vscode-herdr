'use strict';

const LABELS = {
  starting: 'Startet', running: 'Session offen', unknown: 'Session offen · Status unbekannt',
  exited: 'CLI beendet', closed: 'Session beendet', detached: 'Nicht verbunden'
};
const ATTENTION = { none: '', input: 'Braucht Eingabe', review: 'Bereit zum Review' };

function profiles(value) {
  if (!Array.isArray(value)) throw new Error('herdr.agentProfiles muss eine Liste sein.');
  const seen = new Set();
  return value.map(profile => {
    if (!profile || typeof profile.id !== 'string' || !/^[\w-]+$/.test(profile.id) || typeof profile.name !== 'string' || !profile.name.trim()
      || typeof profile.command !== 'string' || !profile.command.trim() || /[\r\n\0]/.test(profile.command)) {
      throw new Error('Agentenprofile brauchen eine eindeutige ID, einen Namen und einen einzeiligen CLI-Befehl.');
    }
    if (seen.has(profile.id)) throw new Error(`Doppelte Agentenprofil-ID: ${profile.id}`);
    if (profile.kind !== undefined && (typeof profile.kind !== 'string' || !/^[\w-]+$/.test(profile.kind))) {
      throw new Error('kind muss ein von herdr unterstützter Agententyp sein.');
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
  if (session.attention === 'input') return { state: 'blocked', icon: 'circle-filled', color: 'charts.yellow', label: 'Braucht Eingabe · manuell' };
  if (session.attention === 'review') return { state: 'done', icon: 'circle-filled', color: 'charts.blue', label: 'Bereit zum Review · manuell' };
  if (session.agentState === 'blocked') return { state: 'blocked', icon: 'circle-filled', color: 'charts.yellow', label: 'Wartet auf Eingabe' };
  if (session.agentState === 'working') return { state: 'working', icon: 'loading~spin', label: 'Arbeitet' };
  if (session.unreadCompletion) return { state: 'done', icon: 'circle-filled', color: 'charts.blue', label: 'Fertig · ungelesen' };
  if (session.agentState === 'idle') return { state: 'idle', icon: 'circle-outline', color: 'descriptionForeground',
    label: session.agentOutcome === 'error' ? 'Fehler · inaktiv' : session.agentOutcome === 'aborted' ? 'Abgebrochen · inaktiv' : 'Inaktiv' };
  if (['exited', 'closed', 'detached'].includes(session.status)) return { state: 'idle', icon: 'circle-outline', color: 'descriptionForeground', label: statusLabel(session) };
  return { state: 'unknown', icon: 'circle-outline', color: 'descriptionForeground', label: session.status === 'starting' ? 'Startet' : 'Agentenstatus unbekannt' };
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
