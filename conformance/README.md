# LXS conformance suite

Language-neutral test vectors for the LXS middleware (decoy routing, `x-ds-*` stripping, client-IP
derivation, blocklist enforcement). Every middleware implementation must pass all of them.

- [`SPEC.md`](SPEC.md): the middleware contract and the vector format.
- [`vectors/`](vectors): the vectors, one JSON file per category.
- [`schema/vector.schema.json`](schema/vector.schema.json): JSON Schema for the vector files.
- [`runners/node/`](runners/node): runs every vector against the Node SDK's Express and Fastify adapters.

```sh
pnpm --filter @lxs/conformance-node test
```
