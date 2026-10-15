// Loaded only for Pi sessions started by this extension. No global Pi settings
// are modified; lifecycle events go directly to the owning herdr server.
import net from 'node:net';

export function registerPiStatus(pi, env = process.env) {
  const paneId = env.HERDR_PANE_ID;
  const address = env.HERDR_SOCKET_PATH;
  if (env.HERDR_ENV !== '1' || !paneId || !address) return;
  const socketPath = process.platform === 'win32' && !address.startsWith('\\\\.\\pipe\\') ? `\\\\.\\pipe\\${address}` : address;
  const source = 'vscode-herdr:pi';
  let sequence = Date.now() * 1000;
  let queue = Promise.resolve();
  let active = false;
  let started = false;
  let prompts = 0;
  let lastState;

  function send(method, params) {
    const seq = ++sequence;
    const message = { id: `${source}:${seq}`, method, params: { pane_id: paneId, source, agent: 'pi', seq, ...params } };
    queue = queue.then(() => new Promise(resolve => {
      const socket = net.createConnection(socketPath);
      const timer = setTimeout(finish, 500);
      function finish() { clearTimeout(timer); socket.destroy(); resolve(); }
      socket.on('error', finish);
      socket.on('end', finish);
      socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
      socket.on('data', finish);
    })).catch(() => {});
    return queue;
  }

  function publish(force = false) {
    if (!started) return;
    const state = prompts > 0 ? 'blocked' : active ? 'working' : 'idle';
    if (!force && state === lastState) return;
    lastState = state;
    void send('pane.report_agent', { state });
  }

  pi.on('session_start', async (event, ctx) => {
    started = true;
    prompts = 0;
    active = ctx.isIdle?.() === false;
    const sessionPath = ctx.sessionManager?.getSessionFile?.();
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (sessionPath || sessionId) await send('pane.report_agent_session', {
      ...(sessionPath ? { agent_session_path: sessionPath } : { agent_session_id: sessionId }),
      session_start_source: event.reason
    });
    publish(true);
  });
  function working() { if (started) { active = true; publish(); } }
  pi.on('before_agent_start', working);
  pi.on('agent_start', working);
  // agent_end can precede retries or queued turns; settlement is the boundary.
  pi.on('agent_settled', (_event, ctx) => {
    if (!started || ctx.isIdle?.() === false) return;
    active = false;
    publish();
  });
  pi.on('ui_prompt_start', () => { prompts++; publish(); });
  pi.on('ui_prompt_end', () => { prompts = Math.max(0, prompts - 1); publish(); });
  pi.events?.on('herdr:blocked', event => {
    prompts = Math.max(0, prompts + (event?.active ? 1 : -1));
    publish();
  });
  pi.on('session_shutdown', async () => {
    if (!started) return;
    started = false;
    await send('pane.release_agent', {});
  });
}

export default registerPiStatus;
