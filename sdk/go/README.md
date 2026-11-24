# LXS Go SDK

Go middleware for LXS. It sits in front of your app and does four things:

1. **Routes decoys.** Requests for decoy paths (`/admin`, `/.env`, ...) go to the local decoy
   server (`ds-web`) and never reach your handlers.
2. **Strips `x-ds-*` headers** that clients send, so nothing in your app can be fooled by them.
3. **Derives the client IP safely** from the TCP peer and, only when you say so, `X-Forwarded-For`.
4. **Enforces the blocklist** from the local agent (`ds-agent`), failing open if the agent is down.

It implements [`conformance/SPEC.md`](../../conformance/SPEC.md) and passes all 80 vectors on
`net/http`, chi, gin and echo (`conformance/runners/go`). The core package uses only the standard
library.

## Install

```sh
go get github.com/SamanPandey-in/lxs/sdk/go          # core, net/http, chi, lxs.yaml loader
go get github.com/SamanPandey-in/lxs/sdk/go/gin      # gin adapter (separate module)
go get github.com/SamanPandey-in/lxs/sdk/go/echo     # echo v4 adapter (separate module)
```

The gin and echo adapters are separate modules so their dependencies never reach apps that do not
use them. Go 1.25 or newer (1.26 for the echo adapter).

## Configure with `lxs.yaml`

Use the same `lxs.yaml` as the rest of LXS (schema: `sdk/lxs/schema/lxs.schema.json`). Run
`lxs build` from the Node CLI to generate the sidecars (`lxs.compose.yml`); the Go app just
reads the file:

```yaml
# yaml-language-server: $schema=https://lxs.dev/schema/lxs.schema.json
service: app
mode: enforce          # or monitor: never blocks, decoys still work
trustProxy: 1          # one reverse proxy in front of the app (see below)
allowlist: [203.0.113.10]
decoys:
  - { type: web-admin, path: /admin }
  - { type: web-bait, path: /.env }
  - { type: ssh, port: 2222 }   # network decoys are ignored by the middleware
```

```go
m, err := lxsyaml.New("lxs.yaml") // import "github.com/SamanPandey-in/lxs/sdk/go/lxsyaml"
if err != nil {
	log.Fatal(err)
}
defer m.Close()
```

`lxsyaml` is a separate package because it brings a YAML parser (`go.yaml.in/yaml/v3`); the core
`lxs` package stays standard-library only. You can also configure in code:

```go
m, err := lxs.New(lxs.Config{
	Mode:       "enforce",
	TrustProxy: 1,
	Decoys: []lxs.Decoy{
		{Type: "web-admin", Path: "/admin"},
		{Type: "web-bait", Path: "/.env"},
	},
})
```

Invalid configuration returns a `*lxs.ConfigError` with the same codes and messages as the Node
SDK (`E_TRUST_PROXY`, `E_OPTIONS`, `E_MOUNT_INVALID`, `E_CONFIG_INVALID`, ...).

The middleware finds the sidecars in `RunDir` (default `$LXS_RUN_DIR`, else `/run/lxs`):
`<runDir>/web/web.sock` and `<runDir>/agent/agent.sock`. If the directory does not exist it is a
no-op (it logs a warning). On Windows it uses the same named pipes as the Node SDK, for local
development only. `LXS_DISABLED=1` turns it off.

## Mount it first

The middleware must run before routing, body parsing and auth.

### net/http

```go
mux := http.NewServeMux()
mux.HandleFunc("GET /api/products", products)
log.Fatal(http.ListenAndServe(":8080", m.Handler(mux)))
```

### chi

```go
r := chi.NewRouter()
r.Use(lxschi.Middleware(m)) // import lxschi "github.com/SamanPandey-in/lxs/sdk/go/chi"
r.Get("/api/products", products)
```

### gin

```go
r := gin.New()
r.Use(lxsgin.Middleware(m)) // import lxsgin "github.com/SamanPandey-in/lxs/sdk/go/gin"; before any route
r.GET("/api/products", products)
```

gin applies global middleware after routing, so call `Use` before registering routes. For the
strongest guarantee, wrap the engine: `http.ListenAndServe(":8080", m.Handler(r))`.

### echo

```go
e := echo.New()
e.Pre(lxsecho.Middleware(m)) // import lxsecho "github.com/SamanPandey-in/lxs/sdk/go/echo"; Pre, not Use
e.GET("/api/products", products)
```

### Other frameworks

`m.Process(w, r)` is the framework-neutral hot path: if it returns `handled == true` the
response is written and the app must not run; otherwise call the next handler, then `done(status)`
if `done` is non-nil.

## trustProxy: getting the client IP right

The blocklist, the allowlist and the address reported to LXS all use the derived client IP. Get
this wrong and an attacker can pick their own address.

| Deployment | Setting |
| --- | --- |
| App faces the internet directly | `trustProxy: false` (default). `X-Forwarded-For` is ignored. |
| N reverse proxies / load balancers in front | `trustProxy: N` (1 to 10). The rightmost N entries are read; anything further left was written by the client. |
| Known proxy addresses | `trustProxy: [10.0.0.0/8]` or the names `loopback`, `uniquelocal`, `linklocal`. Walks right to left and stops at the first untrusted address. |

`trustProxy: true` is rejected (`E_TRUST_PROXY`): it trusts the leftmost entry, which the client
controls. A `/0` allowlist entry is rejected too (`E_OPTIONS`): it would switch blocking off.

## Testing your app

`lxstest.StartFakeAgent` starts a fake `ds-agent` (and, with `FakeDecoy: true`, a fake `ds-web`)
on the real socket paths, so you can mount the middleware in tests:

```go
dir := t.TempDir()
agent, _ := lxstest.StartFakeAgent(lxstest.Options{RunDir: dir, FakeDecoy: true, Blocklist: []string{"203.0.113.7"}})
defer agent.Close()
m, _ := lxs.New(lxs.Config{RunDir: dir, Decoys: []lxs.Decoy{{Type: "web-bait", Path: "/.env"}}})
defer m.Close()
// ... wait for m.Stats().PolicyLoaded, then drive m.Handler(app) ...
```

## Behaviour notes

- Policy is polled every 2 s with `If-None-Match`; until the first answer, and whenever the agent
  is unreachable, the last good policy is used (initially empty). It never blocks because the
  agent is down.
- Decoy request bodies are capped at 64 KiB (413). An unreachable decoy gives 404, a decoy that
  does not answer within 10 s gives 504; neither ever falls back to the app.
- Signals (`asset.blocked`, `honeytoken.use`, `asset.access`) are batched to the agent every
  0.5 s, like the Node SDK.
- Overhead on a non-decoy route is about 0.5 µs and zero allocations per request (see
  `docs/PERFORMANCE.md`, "Middleware overhead").

## Development

```sh
cd sdk/go && go vet ./... && go test ./...
cd conformance/runners/go && go test ./...   # all vectors on net/http, chi, gin, echo
```
