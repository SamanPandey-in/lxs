# Ingest key and project ownership

Ingest keys are project scoped. The key is the identity of the sensor at ingest time:

1. Sign in as the account that should own the data and choose the intended project in the dashboard.
2. Create an ingest key in that project's **Settings** page and copy it once.
3. Put it in `examples/acme-shop/.env.lxs` as `LXS_INGEST_KEY`. Set `LXS_ENDPOINT` to the platform API used by that account. For the local demo, the endpoint is `http://host.docker.internal:8080` from the container.
4. Start or restart the demo agent, then attack `http://localhost:3001` from the attacker console.
5. Sign in as a member of the key's project organization and select that project in the dashboard. The events are stored under the project bound to the key, and project membership controls who can read them.

`pnpm demo` preserves a nonempty key already in `.env.lxs`, sets the local API endpoint for the local demo (override with `LXS_ENDPOINT`), and does not pin the dashboard to the seed user's project. If the key is omitted, it supplies the local development seed key for the demo project. The `.env.lxs` file is ignored by Git; never commit it.

A key created for one project does not redirect events to a different project based on the browser session. Use a key created in the intended project, then select that project in the dashboard.
