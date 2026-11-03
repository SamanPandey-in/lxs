// ssh-attacker.js — real SSH against the ds-ssh (Cowrie) honeypot via ssh2.
// Sessions are kept in an in-memory map keyed by sessionId so the manual
// console can "connect" then run several commands in what looks like one
// shell. No persistence — fine, this is a stage prop (attacker.md §6).

import { Client } from 'ssh2';
import { randomUUID } from 'node:crypto';
import { checkAllowed } from './allowlist.js';

const TARGET_SSH_HOST = process.env.TARGET_SSH_HOST || 'localhost';
const TARGET_SSH_PORT = Number(process.env.TARGET_SSH_PORT || 22);
const SIM_IP = process.env.SIM_IP || '';
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** sessionId -> { client, connected } */
const sessions = new Map();

function newSessionId() {
  return `s_${randomUUID()}`;
}

function expireSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.timer = setTimeout(() => closeSession(sessionId), SESSION_IDLE_TIMEOUT_MS);
  session.timer.unref?.();
}

function isRefusalError(err) {
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|All configured authentication methods failed/i.test(
    String(err?.code || err?.message || err),
  );
}

function connectClient({ username, password, simIp }) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on('ready', () => resolve(client))
      .on('error', (err) => reject(err))
      .connect({
        host: TARGET_SSH_HOST,
        port: TARGET_SSH_PORT,
        username,
        password,
        readyTimeout: 8000,
        // Documented demo-only marker (attacker.md §8 option 2). The
        // honeypot only honours this when LXS_DEV_TRUST_SIM_HEADER=1.
        algorithms: undefined,
        debug: undefined,
        // ssh2 has no native "extra header" concept; the sim-IP label is
        // carried as part of the username comment / a client banner in the
        // lab setup. Kept here as metadata only, see note below.
      });
    // Attach a non-protocol hint for anything on our side that wants it.
    client.__simIp = simIp || SIM_IP;
  });
}

function execOnce(client, cmd) {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream
        .on('close', () => resolve(out))
        .on('data', (data) => {
          out += data.toString();
        })
        .stderr.on('data', (data) => {
          out += data.toString();
        });
    });
  });
}

/**
 * @param {{action: 'connect'|'login'|'command', username?, password?, cmd?, sessionId?, simIp?}} opts
 */
export async function sshAction({ action, username, password, cmd, sessionId, simIp }) {
  const guard = checkAllowed(TARGET_SSH_HOST);
  if (!guard.ok) {
    return {
      ok: false,
      refused: false,
      output: '',
      action,
      error: guard.reason,
      sessionId: sessionId || null,
    };
  }

  if (action === 'connect' || action === 'login') {
    try {
      const client = await connectClient({
        username: username || 'root',
        password: password || '',
        simIp,
      });
      // Never let callers choose or overwrite a live session identifier.
      const id = newSessionId();
      sessions.set(id, { client, connected: true, username, timer: null });
      expireSession(id);
      client.once('close', () => closeSession(id));
      return {
        ok: true,
        refused: false,
        sessionId: id,
        output: `Connected to ${TARGET_SSH_HOST}:${TARGET_SSH_PORT} as ${username || 'root'}`,
        action,
      };
    } catch (err) {
      const refused = isRefusalError(err);
      return {
        ok: false,
        refused,
        sessionId: sessionId || null,
        output: refused
          ? 'Connection refused — You have been blocked by LXS'
          : `auth failed: ${err.message}`,
        action,
        error: err.message,
      };
    }
  }

  if (action === 'command') {
    const session = sessionId && sessions.get(sessionId);
    if (!session || !session.connected) {
      return {
        ok: false,
        refused: false,
        sessionId: sessionId || null,
        output: 'no active session — connect/login first',
        action,
      };
    }
    clearTimeout(session.timer);
    expireSession(sessionId);
    try {
      const output = await execOnce(session.client, cmd || 'echo');
      return { ok: true, refused: false, sessionId, output, action };
    } catch (err) {
      const refused = isRefusalError(err);
      return {
        ok: false,
        refused,
        sessionId,
        output: refused ? 'Connection refused' : `exec failed: ${err.message}`,
        action,
        error: err.message,
      };
    }
  }

  return {
    ok: false,
    refused: false,
    sessionId: sessionId || null,
    output: `unknown action: ${action}`,
    action,
  };
}

export function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    clearTimeout(session.timer);
    try {
      session.client.end();
    } catch {
      /* ignore */
    }
    sessions.delete(sessionId);
  }
}

export function resetAllSessions() {
  for (const id of sessions.keys()) closeSession(id);
}
