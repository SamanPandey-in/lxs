# Alerts (notification channels)

When an incident opens, the worker runs a `notify-incident` job (pg-boss, ~3 s settle delay)
and posts to every **enabled** channel of the project whose `min_severity` is met and whose
`labels` include the incident label (an empty list matches any label).

## Delivery rules

- **Dedupe:** at most one message per incident per severity step per channel
  (`notification_deliveries`, unique on channel + incident + severity).
- **Cooldown (10 min, per channel and attacker):** a same-or-lower severity is skipped; a
  higher non-critical step is deferred to the end of the cooldown and sent then only if it is
  still higher than what was paged. Critical always goes out once, immediately. A newer open
  incident from the same attacker at the same or higher severity supersedes an older one, so a
  replay that opens several incidents pages once.
- **Reliability:** 5 s timeout, no redirects followed (a 3xx is a failure), up to 4 retries
  with exponential backoff (5, 10, 20, 40 s). The result is written to the channel's
  `last_status` / `last_error` / `last_delivered_at` and shown in Settings → Notifications.
- **SSRF:** the URL must be https (http only outside production) with a public host at create
  time. At send time every DNS answer is checked and the request is refused if any address is
  private, loopback, link-local, CGNAT (100.64/10), unique-local IPv6, multicast/reserved, or
  an IPv4-mapped/NAT64/6to4 form of those. The vetted address is the one the socket connects
  to, so DNS rebinding cannot swap it.
- **Test:** `POST /v1/projects/:pid/notification-channels/:cid/test` sends a real test message
  through the same path and returns `{ delivered, status, error }`.

For local testing against a receiver on `localhost`, set `NOTIFY_ALLOW_PRIVATE=true`
(refused when `NODE_ENV=production`).

## Verifying generic webhook signatures

Generic webhooks (`type: "webhook"`) carry:

```
X-LXS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

The signing secret (`whsec_…`) is returned **once**, in the response that creates the channel.
To verify:

1. Split the header on `,` and read `t` and `v1`.
2. Reject if `|now - t|` is more than 300 seconds (replay protection).
3. Compute `HMAC-SHA256(secret, t + "." + rawBody)` as hex, over the **raw** request body bytes
   (before any JSON parsing).
4. Compare with `v1` in constant time.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyLxs(secret, rawBody, header, toleranceSec = 300) {
  const p = Object.fromEntries(header.split(',').map((kv) => kv.split('=', 2)));
  const t = Number(p.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec || !p.v1) return false;
  const want = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const got = Buffer.from(p.v1, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
```

Slack channels are not signed (Slack incoming webhooks are authenticated by their URL).

## Encryption key

Channel URLs and signing secrets are encrypted with AES-256-GCM using `ENCRYPTION_KEY`
(32 bytes, base64 or 64 hex chars; generate with `openssl rand -base64 32`). Ciphertext starts
with a key-version byte. Rows written before `ENCRYPTION_KEY` existed used a key derived from
`SESSION_SECRET`; they still decrypt, and `pnpm --filter @lxs/api db:reencrypt-channels`
rewrites them in the new format. Run it before rotating `SESSION_SECRET`.
