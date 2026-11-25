// "Which token leaked where" (lib/honeytoken-attribution.js).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { leakSentence, tokenLeaks } = await import("../lib/honeytoken-attribution.js");

const use = (over = {}) => ({
  event_type: "honeytoken.use",
  src_ip: "198.51.100.4",
  occurred_at: "2026-11-24T11:30:00.000Z",
  count: 1,
  fields: {
    honeytoken_id: "ht_api_01.swvxpgns7opr",
    url: "/api/orders",
    honeytoken_attribution: {
      mint_id: "ht_api_01.swvxpgns7opr",
      base_token_id: "ht_api_01",
      minted_for_ip: "203.0.113.9",
      minted_at: "2026-11-24T10:02:00.000Z",
      planted_via: "/.env",
      session_id: null,
      decoy_id: "web-bait-env",
    },
  },
  ...over,
});

describe("tokenLeaks", () => {
  it("attributes a per-visitor token to the visit that took it", () => {
    const [r] = tokenLeaks([{ event_type: "http.request" }, use(), use()]);
    assert.equal(r.mintedForIp, "203.0.113.9");
    assert.equal(r.usedFromIp, "198.51.100.4");
    assert.equal(r.handedOff, true);
    assert.equal(r.uses, 2);
    assert.equal(
      leakSentence(r),
      "Token minted for 203.0.113.9 at 2026-11-24T10:02:00.000Z via /.env, used from 198.51.100.4 at 2026-11-24T11:30:00.000Z",
    );
  });

  it("explains static and unresolved tokens instead of guessing", () => {
    const rows = tokenLeaks([
      use({ fields: { honeytoken_id: "ht_api_01" } }),
      use({ fields: { honeytoken_id: "ht_api_01.aaaaaaaaaaaa" } }),
    ]);
    assert.match(leakSentence(rows[0]), /not attributable to one visitor/);
    assert.match(leakSentence(rows[1]), /mint record not found/);
    assert.equal(rows[1].baseTokenId, "ht_api_01");
    assert.deepEqual(tokenLeaks([]), []);
  });
});
