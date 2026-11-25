// "Which token leaked where": per-visitor honeytoken attribution from an incident's events.
// The API attaches `fields.honeytoken_attribution` to a honeytoken.use event whose token was minted
// for one visitor (stream L). A static per-deployment token has no attribution: the row says so.

const MINT_ID_RE = /^([A-Za-z0-9_-]{1,50})\.([a-z2-7]{12})$/;

/** One row per used token (first use wins; later uses add to the count). */
export function tokenLeaks(events) {
  const byToken = new Map();
  for (const e of events ?? []) {
    if (e?.event_type !== "honeytoken.use") continue;
    const f = e.fields ?? {};
    const id = f.honeytoken_id ?? "unknown";
    const prev = byToken.get(id);
    if (prev) {
      prev.uses += e.count ?? 1;
      continue;
    }
    const a = f.honeytoken_attribution ?? null;
    const minted = MINT_ID_RE.test(id);
    byToken.set(id, {
      tokenId: id,
      baseTokenId: a?.base_token_id ?? (minted ? MINT_ID_RE.exec(id)[1] : id),
      perVisitor: minted,
      mintedForIp: a?.minted_for_ip ?? null,
      mintedAt: a?.minted_at ?? null,
      plantedVia: a?.planted_via ?? null,
      sessionId: a?.session_id ?? null,
      decoyId: a?.decoy_id ?? null,
      usedFromIp: e.src_ip ?? null,
      usedAt: e.occurred_at ?? null,
      usedOn: f.url ?? e.dst_service ?? null,
      uses: e.count ?? 1,
      // Different addresses: the visitor who took the token passed it on (or switched hosts).
      handedOff: Boolean(a?.minted_for_ip && e.src_ip && a.minted_for_ip !== e.src_ip),
      attributed: Boolean(a),
    });
  }
  return [...byToken.values()];
}

/** The one-line sentence the panel leads with. `fmt` formats an ISO time. */
export function leakSentence(row, fmt = (iso) => iso) {
  const used = `used from ${row.usedFromIp ?? "?"} at ${fmt(row.usedAt)}`;
  if (row.attributed)
    return `Token minted for ${row.mintedForIp} at ${fmt(row.mintedAt)} via ${row.plantedVia}, ${used}`;
  if (row.perVisitor) return `Per-visitor token ${row.tokenId}, ${used} (mint record not found)`;
  return `Deployment-wide token ${row.tokenId}, ${used} (not attributable to one visitor)`;
}
