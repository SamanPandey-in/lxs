# Changelog

## 0.2.0 (unreleased)

Minor bump: contains a breaking configuration change (pre-1.0).

### Breaking

- **`trustProxy: true` is rejected** with `E_TRUST_PROXY`. It made the leftmost `X-Forwarded-For` entry the client
  address, and the client writes that entry, so any attacker could choose the IP the middleware saw (dodging a block,
  or getting someone else blocked). A `/0` entry in a `trustProxy` list is rejected for the same reason.
- **`allowlist` rejects prefix length 0** (`0.0.0.0/0`, `::/0`): it would disable blocking entirely. The middleware
  also ignores such an entry in the allowlist polled from the platform.

### Migration

```ts
// before
new LXS({ trustProxy: true });

// after: count the proxies in front of the app (only if it is unreachable except through them) ...
new LXS({ trustProxy: 1 });
// ... or list the proxies' addresses
new LXS({ trustProxy: ['loopback'] });      // nginx on the same host
new LXS({ trustProxy: ['10.0.0.0/8'] });    // a load balancer in a private network
```

Replace an allowlist entry of `0.0.0.0/0` with the ranges of your own scanners and uptime monitors, or use
`mode: 'monitor'` if the goal was to never block.

### Added

- `trustProxy` hop count (integer 1-10): `X-Forwarded-For` is walked from the right, skipping that many trusted hops.
- `telemetry: { dir, sources? }`: mounts a host directory read-only into `ds-agent`, which tails `firewall.jsonl` /
  `auth.jsonl` and reports `prod.firewall` / `prod.auth` events for correlation with real assets.
- The middleware forwards the decoy's own session cookie (`PHPSESSID`, in the exact format `ds-web` issues) to the
  decoy; every other cookie is still stripped.

### Changed (decoy images)

- `ds-web` keys sessions on client IP + its session cookie (IP only when the client keeps no cookie), randomises the
  `acceptAfter` threshold per session within N..N+2, and evicts least-recently-seen state instead of refusing or
  clearing it when full.
- `ds-agent` evicts least-recently-seen buckets in the auth flood collapser instead of clearing all of them at 20,000
  sources.
