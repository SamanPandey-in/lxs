# Local Saman demo account

Run `pnpm seed:saman` from the repository root after Postgres is available. This idempotently creates or resets the local prototype account `saman` (`saman@mail.com`) and attaches the `acme-shop` project to an organization where Saman is an owner. Existing project IDs, ingest keys, sensors, events, and incidents are retained when the project is reassigned.

The prototype password is `qwertyuiop[]\` (including the final backslash). This is a local demo credential; do not reuse it outside this prototype. The seed stores only its password hash.

This seed is an optional fixture; `pnpm demo` does not create or select Saman's account automatically. To use the seed account in the launcher's own demo checks, set `LXS_DEMO_EMAIL`, `LXS_DEMO_USERNAME`, and `LXS_DEMO_PASSWORD`.
