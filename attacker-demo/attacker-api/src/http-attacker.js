// http-attacker.js — performs one real HTTP request against TARGET_APP_URL
// and classifies the result: blocked / decoy / real.

import { request } from 'undici';
import { checkAllowed } from './allowlist.js';

const TARGET_APP_URL = process.env.TARGET_APP_URL || 'http://localhost:3000';
const SIM_IP = process.env.SIM_IP || '';

function looksBlocked(status, bodyText) {
  if (status === 403) return true;
  if (!bodyText) return false;
  return /blocked by lxs|forbidden/i.test(bodyText);
}

function looksLikeDecoy(headers, bodyText) {
  if (headers['x-ds-decoy']) return true;
  if (!bodyText) return false;
  // heuristic fallback until the platform confirms a marker header (open
  // question #1 in attacker.md): decoy pages tend to be short canned HTML.
  return /decoy|honeypot|fake/i.test(bodyText);
}

/**
 * @param {{method?: string, path: string, headers?: object, body?: string, simIp?: string}} opts
 */
export async function sendHttp({ method = 'GET', path = '/', headers = {}, body, simIp }) {
  let url;
  try {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('path_must_be_root_relative');
    url = new URL(path, TARGET_APP_URL);
    if (url.origin !== new URL(TARGET_APP_URL).origin) throw new Error('path_must_be_root_relative');
  } catch (err) {
    return { status: 0, blocked: false, isDecoy: false, body: '', note: `refused: ${err.message}`, error: err.message };
  }
  const guard = checkAllowed(url.hostname);
  if (!guard.ok) {
    return {
      status: 0,
      blocked: false,
      isDecoy: false,
      body: '',
      note: `refused: ${guard.reason}`,
      error: guard.reason,
    };
  }

  const reqHeaders = {
    'user-agent': headers['User-Agent'] || headers['user-agent'] || 'LXS-AttackerDemo/1.0',
    ...headers,
  };
  const sim = simIp || SIM_IP;
  if (sim) reqHeaders['X-DS-Sim-IP'] = sim;

  try {
    const res = await request(url, {
      method,
      headers: reqHeaders,
      body: body ?? undefined,
      // Demo prop: short timeout so a dead target doesn't hang the console.
      headersTimeout: 8000,
      bodyTimeout: 8000,
    });

    const bodyText = await res.body.text();
    const status = res.statusCode;
    const resHeaders = Object.fromEntries(
      Object.entries(res.headers).map(([k, v]) => [
        k.toLowerCase(),
        Array.isArray(v) ? v.join(',') : v,
      ]),
    );
    const blocked = looksBlocked(status, bodyText);
    const isDecoy = looksLikeDecoy(resHeaders, bodyText);

    return {
      status,
      blocked,
      isDecoy,
      headers: resHeaders,
      body: bodyText.slice(0, 2000),
      note: blocked ? 'You have been blocked by LXS' : undefined,
    };
  } catch (err) {
    // Connection refused / reset — after a dashboard block this is the other
    // shape the "blocked" story can take.
    const refused = /ECONNREFUSED|ECONNRESET|UND_ERR_CONNECT_TIMEOUT/.test(
      String(err.code || err.message),
    );
    return {
      status: 0,
      blocked: refused,
      isDecoy: false,
      body: '',
      note: refused
        ? 'Connection refused — You have been blocked by LXS'
        : `request failed: ${err.message}`,
      error: err.message,
    };
  }
}
