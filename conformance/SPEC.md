# LXS middleware contract

This is the contract every LXS middleware implements: Node (Express, Fastify, plain `node:http`),
Go (`net/http`, chi, gin, echo) and anything that follows. It is written so that you can build a
conforming middleware from this file and `vectors/*.json`, without reading the Node source.

The vectors are normative. Where this prose and a vector disagree, the vector wins and this file
has a bug.

- `vectors/*.json`: the test vectors, one file per category.
- `schema/vector.schema.json`: the JSON Schema for those files.
- `runners/node/`: the reference runner (`pnpm --filter @lxs/conformance-node test`).

Status: **vector format v1, frozen.** Adding vectors or categories is fine. Changing a field's
meaning or adding a required field needs a new format version and a note here.

## 1. Where the middleware sits

```
            internet / reverse proxy
                      │
             ┌────────▼────────┐   GET /v1/policy, POST /v1/signals
             │  app + LXS      │──────────────────────────────────► ds-agent   <runDir>/agent/agent.sock
             │  middleware     │
             │                 │   decoy requests (HTTP/1.1)
             │                 │──────────────────────────────────► ds-web     <runDir>/web/web.sock
             └─────────────────┘
```

The middleware runs first in the app's request pipeline, before routing, body parsing and auth.
It talks to two sidecars over Unix sockets in a shared run directory (`runDir`, default `$LXS_RUN_DIR`
or `/run/lxs`):

| Socket | Peer | Used for |
| --- | --- | --- |
| `<runDir>/web/web.sock` | ds-web, the web decoy server (no network) | proxying decoy requests |
| `<runDir>/agent/agent.sock` | ds-agent, the only container holding the platform key | reading the policy, posting signals |

(The Node SDK uses Windows named pipes for local development on Windows; that is not part of the
contract.)

It has four duties. Each section below states the rules; the vectors pin the edge cases.

1. **Route decoys** over the web socket (section 2.2).
2. **Strip `x-ds-*`**: the `x-ds-` header namespace belongs to LXS (section 2.3).
3. **Derive the client IP** safely (section 2.4).
4. **Enforce the blocklist** from the policy document (section 2.5).

Every request ends in exactly one of three outcomes:

| Outcome | Meaning |
| --- | --- |
| `pass_through` | The middleware hands the request to the next handler (the app). |
| `decoy` | The middleware proxies the request to ds-web and relays the response. The app never sees it. |
| `blocked` | The middleware answers itself with a status code (403, or 413 for an oversized decoy body). The app never sees it. |

## 2. Rules

### 2.1 Configuration

The middleware is configured with (vector field `config`):

| Field | Type | Meaning |
| --- | --- | --- |
| `mode` | `"enforce"` \| `"monitor"` | `monitor` never blocks. Decoys work in both modes. |
| `trustProxy` | `false` \| integer 1..10 \| list of strings | How to read `X-Forwarded-For` (section 2.4). |
| `allowlist` | list of CIDRs | Clients that are never blocked and never routed to decoys. |
| `decoys` | list of `{id, path, prefix}` | Web decoys. `prefix: true` is a `web-admin` decoy, `false` a `web-bait` decoy. |

In a real deployment these come from `lxs.yaml` (or `decoy.config.ts`); see
`sdk/lxs/schema/lxs.schema.json`. The mapping from a config file decoy is:
`{type: web-admin, path}` → `{id, path, prefix: true}`, `{type: web-bait, path}` → `{id, path, prefix: false}`.
The default id is `<type>-<slug(path)>`, where slug lowercases the path, replaces every run of
characters outside `[a-z0-9]` with `-`, trims leading and trailing `-`, cuts to 48 characters and
falls back to `root` (`/.env` → `web-bait-env`, `/admin` → `web-admin-admin`). An explicit `id`
wins. `.lxs/manifest.json` lists the resolved decoys with their ids.

Config-time validation (bad CIDRs, a `/0` allowlist entry, `trustProxy: true`, reserved decoy
paths) is the config loader's job and is not covered by these vectors: vectors only use valid configs.

### 2.2 Decoy routing

**The match path.** From the request-target:

1. If the target is in absolute form (`scheme://authority...`, scheme is `[A-Za-z][A-Za-z0-9+.-]*`),
   reduce it to origin form: everything after the authority, with a leading `/` added if missing
   (`http://h/.env?x` → `/.env?x`, `http://h` → `/`, `http://h?x=1` → `/?x=1`). Call the result
   the *target*. Any other target is used as is.
2. Cut the target at the first `?`.
3. If the result contains `%`, percent-decode it once, as UTF-8. If decoding fails (an invalid
   escape such as `%zz`, or bytes that are not valid UTF-8 such as `%ff`), use the undecoded string
   for the whole path. Decoding is all or nothing.
4. If the result is longer than one character and ends in `/`, remove that one `/`.

Nothing else is normalised: matching is case-sensitive, `//` is not collapsed, `.` and `..`
segments are not resolved, `;` parameters are kept, a decoded NUL is an ordinary character.

**Matching.** A decoy matches when the match path equals its `path`, or, for `prefix: true`
decoys only, starts with `path + "/"`. Exact matches are checked before prefixes. (Decoy paths are
unique and never end in `/`.)

**Proxying.** On a match (and after the allowlist and blocklist checks, section 2.6), send the
request to ds-web as HTTP/1.1 over `<runDir>/web/web.sock`:

- method: unchanged;
- request-target: the *target* from step 1 (origin form, query included, *not* decoded);
- headers: every request header except
  - hop-by-hop: `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`,
    `trailer`, `upgrade` (your HTTP client may add its own `Connection`);
  - real users' credentials: `cookie`, `authorization`, `proxy-authorization`;
  - every header whose lower-cased name starts with `x-ds-`;
- plus, set by the middleware:
  - `x-ds-client-ip`: the derived client address (section 2.4), canonical form;
  - `x-ds-decoy-id`: the matched decoy's `id`;
  - `x-ds-request-id`: a fresh id, at most 64 characters of `[0-9a-z]` (Node: base-36 milliseconds
    plus 12 hex characters);
  - `cookie: PHPSESSID=<v>` only when the decoy session rule below finds one;
- body: streamed through. If `Content-Length` is greater than 65536, answer `413` without
  contacting ds-web. If more than 65536 body bytes arrive anyway (chunked), abort the upstream
  request and answer 413 if no response has started.

**The decoy session cookie.** ds-web issues its own session cookie, `PHPSESSID`, scoped to the
decoy path. It is the only cookie forwarded. Join all `Cookie` header lines with `"; "`. If the
result is empty or longer than 8192 characters, forward nothing. Otherwise split on `;`; for each
part, take the text before the first `=`, trimmed, as the name and the rest, trimmed, as the value.
The first part whose name is exactly `PHPSESSID` (case-sensitive) and whose value matches
`^[0-9a-v]{26}$` wins, and is forwarded as `PHPSESSID=<value>`. Parts that fail the test are
skipped.

**The response** from ds-web is relayed with its status and headers, minus hop-by-hop headers and
`transfer-encoding`. If ds-web is unreachable, answer `404 Not Found` (plain text); if it does not
answer within 10 seconds, `504`. Never fall back to the app: decoy paths must never reach it.

### 2.3 The `x-ds-*` namespace

Headers whose lower-cased name starts with `x-ds-` are LXS's. A client can send them; nothing may
trust them.

- On `decoy`: they are dropped and the middleware sets its own (above).
- On `pass_through`: they are deleted from the request before the app sees it, whatever the reason
  for passing (no decoy, allowlisted, monitor mode, internal error).
- The client address is never read from an `x-ds-*` header. (The Node SDK has a development-only
  switch, `LXS_DEV_TRUST_SIM_HEADER=1`, refused when `NODE_ENV=production`, that reads
  `x-ds-sim-ip` for the local attack simulator. Other implementations do not need it; vectors run
  with it off.)

### 2.4 Client IP

**Canonical form.** Every address the middleware compares or reports is canonical: IPv4 in dotted
decimal; IPv6 per RFC 5952 (lower case, leading zeros dropped, the longest run of two or more zero
groups compressed to `::`, the first one on a tie); an IPv4-mapped IPv6 address
(`::ffff:a.b.c.d`, also written in hex as `::ffff:xxxx:xxxx`) becomes the IPv4 address; an IPv6
zone (`%eth0`) is dropped. A string is an address only if it parses as a plain IPv4 or IPv6 literal:
no port, no brackets, no surrounding text.

**The socket address** is the TCP peer address of the connection, canonicalised.

**X-Forwarded-For.** Join all `X-Forwarded-For` header lines with `,` in order, split on `,`, trim
each entry (spaces and tabs) and canonicalise IPv4-mapped entries. If there are more than 64
entries, keep the last 64. An empty header means an empty list.

**`trustProxy: false`** (default): the client is the socket address. `X-Forwarded-For` is ignored.

**`trustProxy: n`** (hop count, 1..10): `n` proxies sit in front of the app. Walk the list from the
right, at most `n` entries (stop early at the left end). If an entry walked is not a valid address,
the client is the socket address. Otherwise the client is the last entry walked; with an empty list
it is the socket address. Entries further left are never read.

```
xff = [e0, e1, ..., e(m-1)]
client = socket
for k in 1..n:
    if m - k < 0: break
    if not valid(e(m-k)): return socket
    client = e(m-k)
return client
```

**`trustProxy: [...]`** (trusted proxy list): entries are CIDRs or the names `loopback`
(`127.0.0.0/8`, `::1/128`), `uniquelocal` (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
`fc00::/7`) and `linklocal` (`169.254.0.0/16`, `fe80::/10`). If the socket address is not trusted,
the client is the socket address. Otherwise walk the list from the right: an invalid entry returns
the socket address; the first untrusted entry is the client; if every entry is trusted, the client
is the leftmost entry; an empty list gives the socket address.

The derived address, canonicalised, is what the allowlist, the blocklist and `x-ds-client-ip` use.

### 2.5 Policy document and blocklist

ds-agent serves the policy at `GET /v1/policy` on the agent socket, as JSON:

```json
{
  "version": 7,
  "blocklist": ["198.51.100.7", "203.0.113.0/24", "2001:db8::/32"],
  "allowlist": ["192.0.2.0/24"],
  "watchlist": ["198.51.100.9"],
  "honeytokens": { "<sha256 hex of a planted token>": "<token id>" }
}
```

Poll it every 2 seconds off the request path, sending `If-None-Match` with the last `ETag`; `304`
means unchanged. Until the first successful fetch, and whenever the agent is unreachable or answers
garbage, keep the last good policy (initially empty): **fail open**, never block or fail a request
because the agent is down. Ignore non-string list items.

Blocklist entries:

- An entry containing `/` is a CIDR `addr/bits`. `bits` is 1 to 3 decimal digits, at most 32 for
  IPv4 and 128 for IPv6. An IPv4-mapped IPv6 CIDR (`::ffff:a.b.c.d/b`, `b` 96..128) is the IPv4
  CIDR `a.b.c.d/(b-96)`; with `b` below 96 it is invalid. More than one `/`, a non-numeric or
  out-of-range prefix, or an invalid address make the entry invalid. An IPv4 CIDR never matches an
  IPv6 client and vice versa.
- Any other entry is an exact address, compared canonically (so `2001:DB8:0:0:0:0:0:7` blocks
  `2001:db8::7`).
- Invalid entries are ignored. They must never be widened into something that matches more.

In `enforce` mode a client whose address matches the blocklist gets `403`, `content-type:
text/plain; charset=utf-8`, body `Forbidden` (generic: no product name). In `monitor` mode the
blocklist is never applied.

Allowlist entries (in `config.allowlist` and in the policy `allowlist`) use the same CIDR syntax;
an entry without `/` is a single address (`/32` or `/128`), and the policy allowlist also accepts
the named ranges listed under `trustProxy` in section 2.4. Invalid entries are ignored. A `/0` entry
in the policy allowlist (`0.0.0.0/0`, `::/0`, or the mapped `::ffff:0.0.0.0/96`) is ignored: it
would switch blocking off for everyone. (`config.allowlist` rejects `/0` when the config is loaded.)

### 2.6 Order of evaluation

```
ip = derive_client_ip(request)                     # 2.4
if ip in config.allowlist or ip in policy.allowlist:
    strip x-ds-*; pass_through                     # allowlisted: no blocking, no decoys
target = origin_form(request-target)
path = match_path(target)                          # 2.2
if mode == enforce and ip in policy.blocklist:
    blocked 403                                    # before decoys
if decoy = match(path):
    proxy to ds-web                                # decoy (or 413 / 404 / 504)
strip x-ds-*; pass_through
```

Any unexpected internal error fails open: strip `x-ds-*` and pass through.

### 2.7 Signals (not covered by the vectors)

The middleware also reports to ds-agent with `POST /v1/signals` and the body
`{"signals": [...], "dropped": n}`, batched (at most 200 per post, every 0.5 s, a bounded queue of
1000, oldest dropped first, retried on failure):

- `asset.blocked` when it returns 403 (at most once per client and path per minute);
- `honeytoken.use` when the configured honeytoken header carries a value whose SHA-256 is in the
  policy's `honeytokens` map (only values starting with the configured prefix, at most 256 characters,
  after an optional `Bearer `-style scheme, are hashed);
- `asset.access` when a watchlisted client requests a path, after the response, with the status and
  the matching declared asset (at most once per client and path per minute).

Each signal has `kind`, `ip`, `method`, `path` (the match path) and `ts` (ISO 8601). These are
behaviours of the Node SDK that a port should copy, but they are outside the vector format.

## 3. Vector format (v1, frozen)

Each file in `vectors/` is a JSON object:

```json
{
  "$schema": "../schema/vector.schema.json",
  "category": "routing",
  "description": "What this file covers.",
  "vectors": [ /* vector objects */ ]
}
```

A vector:

```json
{
  "name": "ip-hop1",
  "description": "One trusted hop: the rightmost X-Forwarded-For entry is the client.",
  "config": {
    "mode": "enforce",
    "trustProxy": 1,
    "allowlist": [],
    "decoys": [
      { "id": "web-admin-admin", "path": "/admin", "prefix": true },
      { "id": "web-bait-env", "path": "/.env", "prefix": false }
    ]
  },
  "policy": { "blocklist": [], "allowlist": [] },
  "request": {
    "method": "GET",
    "target": "/.env",
    "headers": [["x-forwarded-for", "198.51.100.1"]],
    "remoteAddress": "10.0.0.2"
  },
  "expect": {
    "outcome": "decoy",
    "decoy": { "id": "web-bait-env", "clientIp": "198.51.100.1" }
  }
}
```

| Field | Meaning |
| --- | --- |
| `name` | Unique across all files, stable; `[a-z0-9-]`. |
| `description` | One sentence: the rule under test. |
| `config` | Middleware configuration (section 2.1), fully spelled out. A runner applies no defaults. |
| `policy` | The policy document the fake agent serves (`blocklist`, `allowlist`; `watchlist` and `honeytokens` are empty). |
| `request.method` | Request method. |
| `request.target` | The request-target exactly as written on the request line. |
| `request.headers` | Header lines in order, as `[name, value]` pairs. Names may repeat (each pair is one line). |
| `request.remoteAddress` | The TCP peer address the app's server sees. |
| `request.body` / `request.bodyBytes` | Optional body: a UTF-8 string, or that many `a` bytes. At most one of the two. |
| `expect.outcome` | `pass_through`, `decoy` or `blocked`. |
| `expect.app.headers` | `pass_through` only: assertions on the headers the app receives. |
| `expect.decoy` | `decoy` only: `id` (expected `x-ds-decoy-id`), `clientIp` (expected `x-ds-client-ip`), optional `method`, `target` (the request-target ds-web receives) and `headers`. |
| `expect.status` | `blocked` only: the status the middleware answers with. |
| `expect.frameworkMayReject` | Optional. The target is malformed enough that an HTTP server may answer 400 before any middleware runs (Fastify does for `%zz` and `%ff`; Go's `net/http` does for `%zz`). A runner accepts a 400 with no app and no decoy hit; if the middleware does run, the stated outcome applies. |

Header assertions map a lower-case header name to:

- a string: the header is present with exactly this value;
- `true`: the header is present with a non-empty value;
- `null`: the header is absent.

Headers not named are not checked. A runner compares a header that arrived on several lines as the
values joined with `", "`; the vectors avoid asserting on such headers.

### 3.1 How a runner executes a vector

1. Create a fresh run directory. Start a fake ds-agent on its agent socket that serves `policy` at
   `GET /v1/policy` (with an `ETag`) and accepts `POST /v1/signals`. Start a fake ds-web on its web
   socket that records each request's method, target and headers, drains the body and answers
   `200` with body `decoy`.
2. Build the middleware from `config` with that run directory. Mount it, first, in a tiny app whose
   only handler records the request's headers, drains the body and answers `200` with body `app`.
3. Wait until the middleware has applied the policy (the reference runner waits for the first
   policy response plus 30 ms).
4. Send the request over a TCP connection, byte for byte: the request line `METHOD target HTTP/1.1`,
   then the header lines in order, then `Host: conformance.test` if the vector has no `Host`,
   `Connection: close`, and `Content-Length` when there is a body. The TCP peer address the
   middleware sees must be `request.remoteAddress` (the Node runner overrides the socket's
   `remoteAddress` per request, keyed by a private header that it removes before the middleware
   runs; a Go runner can set `r.RemoteAddr` in a wrapping handler, or call the handler directly with
   an `httptest` request).
5. Check:
   - `pass_through`: status 200, the app saw the request exactly once, ds-web saw nothing, and the
     app's headers satisfy `expect.app.headers`.
   - `decoy`: status 200, ds-web saw the request exactly once, the app saw nothing,
     `x-ds-decoy-id` = `decoy.id`, `x-ds-client-ip` = `decoy.clientIp`, `x-ds-request-id` is
     present, and `method`, `target` and `headers` hold when given.
   - `blocked`: the status equals `expect.status`, and neither the app nor ds-web saw the request.
6. Tear everything down.

A middleware conforms when every vector passes on every framework adapter it ships.

## 4. Categories

| File | Covers |
| --- | --- |
| `routing.json` | exact and prefix matching, query strings, trailing slashes, case, percent-encoding tricks (`%2e`, `%2F`, double encoding, invalid escapes, invalid UTF-8), double slashes, dot segments, absolute-form targets |
| `headers.json` | `x-ds-*` stripping on both outcomes, credential and hop-by-hop stripping on decoys, the `PHPSESSID` rule, the 64 KiB decoy body limit |
| `client-ip.json` | `trustProxy` false / hop count / proxy list, spoofed and malformed `X-Forwarded-For`, IPv6 and IPv4-mapped canonicalisation |
| `blocklist.json` | exact and CIDR entries, IPv4 and IPv6, mapped forms, invalid entries, blocking before decoys, blocking on the derived address |
| `mode.json` | `monitor` vs `enforce` |
| `allowlist.json` | static and policy allowlists overriding the blocklist and decoys, `/0` entries ignored, spoof resistance |

## 5. Changelog

- v1: initial format (80 vectors).

## 6. Implementations

| Implementation | Adapters | Runner | Result |
| --- | --- | --- | --- |
| Node SDK (`sdk/lxs`) | Express, Fastify | `runners/node` (`pnpm --filter @lxs/conformance-node test`) | all vectors |
| Go SDK (`sdk/go`) | `net/http`, chi, gin, echo | `runners/go` (`cd conformance/runners/go && go test ./...`) | all vectors (80/80 on each adapter) |

The Go runner validates the vector files against `schema/vector.schema.json` by hand (standard
library only), then sends each request byte for byte over TCP, sets the TCP peer address with a
wrapping handler, and runs a fake ds-agent and ds-web on the real socket paths (Unix sockets, or
the Node SDK's named pipes on Windows). Go's `net/http` answers `400` for `%zz` before any
middleware runs, which `frameworkMayReject` allows; `%ff` reaches the middleware and passes
through.
