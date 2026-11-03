// allowlist.js — target guard (attacker.md §9)
//
// attacker-api can send real SSH and real HTTP, so every target (host) it is
// asked to hit must be checked against ALLOW_TARGETS before anything happens.
// Refuses anything not explicitly allowed, and refuses public IPs unless the
// operator has explicitly opted in.

const ALLOW_TARGETS = (process.env.ALLOW_TARGETS || 'localhost')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOW_PUBLIC = process.env.ALLOW_PUBLIC === '1';

function hostnameOf(target) {
  try {
    if (target.includes('://')) return new URL(target).hostname;
    // bare host or host:port
    return target.split(':')[0];
  } catch {
    return target;
  }
}

// Very small, dependency-free private/loopback IP check. Good enough for a
// demo prop guardrail — not a security boundary.
function isPrivateOrLoopbackIp(host) {
  if (host === 'localhost') return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // not an IPv4 literal — treat hostnames as "unknown", allowlist decides
  const [a, b] = m.slice(1).map(Number);
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/**
 * Checks whether `target` (a URL, a bare hostname, or "host:port") may be
 * attacked. Returns { ok: true } or { ok: false, reason }.
 */
export function checkAllowed(target) {
  if (!target) return { ok: false, reason: 'no_target' };
  const host = hostnameOf(target);

  if (!ALLOW_TARGETS.includes(host)) {
    return { ok: false, reason: 'target_not_allowed', host, allowed: ALLOW_TARGETS };
  }

  if (!isPrivateOrLoopbackIp(host) && !ALLOW_PUBLIC) {
    // Hostname isn't a recognizably-private literal — in the lab this is
    // normally fine (e.g. "acme-shop.demo" resolves inside the lab network),
    // but if ALLOW_PUBLIC isn't set and it looks like a public IP, refuse.
    const isPublicIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
    if (isPublicIp) {
      return { ok: false, reason: 'public_target_refused', host };
    }
  }

  return { ok: true, host };
}

export function getAllowTargets() {
  return ALLOW_TARGETS;
}
