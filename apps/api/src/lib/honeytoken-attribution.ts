import type { DecoyEvent } from '@lxs/schema';
import { and, sql as dsql, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { honeytokenMints } from '../db/schema.js';

/**
 * Per-visitor honeytoken attribution (stream L). ds-web mints a unique API key per visitor and the
 * agent ships a `honeytoken.mint` event for each; those go into `honeytoken_mints`, not the event
 * stream, so detection never sees them. When the SDK later reports `honeytoken.use` with a minted
 * id, the use event's fields get a `honeytoken_attribution` block (who the token was minted for,
 * when, via which bait) and the mint row records the first use. Scoring is untouched: R16 fires on
 * the use exactly as it does for the static per-deployment token.
 */

/** `<base id>.<12 base32 chars>`: a minted id. A bare base id is the static (legacy) token. */
export const MINT_ID_RE = /^([A-Za-z0-9_-]{1,50})\.([a-z2-7]{12})$/;

export const isMintId = (id: string | undefined): id is string => !!id && MINT_ID_RE.test(id);

/** The platform-registered token a minted id derives from (`ht_api_01.k3j9...` -> `ht_api_01`). */
export const baseTokenId = (id: string): string => MINT_ID_RE.exec(id)?.[1] ?? id;

export interface HoneytokenAttribution {
  mint_id: string;
  base_token_id: string;
  minted_for_ip: string;
  minted_at: string;
  planted_via: string;
  session_id: string | null;
  decoy_id: string | null;
}

export function splitMintEvents(valid: DecoyEvent[]): {
  mints: DecoyEvent[];
  events: DecoyEvent[];
} {
  const mints: DecoyEvent[] = [];
  const events: DecoyEvent[] = [];
  for (const e of valid) {
    if (e.event_type === 'honeytoken.mint') {
      if (isMintId(e.honeytoken_id)) mints.push(e);
    } else events.push(e);
  }
  return { mints, events };
}

export function mintRow(projectId: string, e: DecoyEvent): typeof honeytokenMints.$inferInsert {
  const id = e.honeytoken_id as string;
  return {
    projectId,
    mintId: id,
    baseTokenId: baseTokenId(id),
    decoyKey: e.decoy_id ?? null,
    sessionId: e.session_id ?? null,
    mintedForIp: e.src_ip,
    plantedVia: (e.url ?? e.dst_service.replace(/^http:/, '')).slice(0, 2048),
    mintedAt: new Date(e.timestamp),
  };
}

type MintRow = typeof honeytokenMints.$inferSelect;

export function toAttribution(r: MintRow): HoneytokenAttribution {
  return {
    mint_id: r.mintId,
    base_token_id: r.baseTokenId,
    minted_for_ip: r.mintedForIp,
    minted_at: r.mintedAt.toISOString(),
    planted_via: r.plantedVia,
    session_id: r.sessionId,
    decoy_id: r.decoyKey,
  };
}

/** Minted ids referenced by honeytoken.use events in a batch. */
export function usedMintIds(events: DecoyEvent[]): string[] {
  return [
    ...new Set(
      events
        .filter((e) => e.event_type === 'honeytoken.use' && isMintId(e.honeytoken_id))
        .map((e) => e.honeytoken_id as string),
    ),
  ];
}

/** Store mint events (first mint wins: a refetch by the same visitor re-logs the same id). */
export async function storeMints(tx: Tx, projectId: string, mints: DecoyEvent[]): Promise<number> {
  if (mints.length === 0) return 0;
  const seen = new Set<string>();
  const rows = mints
    .filter((m) => {
      const id = m.honeytoken_id as string;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((m) => mintRow(projectId, m));
  const out = await tx
    .insert(honeytokenMints)
    .values(rows)
    .onConflictDoNothing({ target: [honeytokenMints.projectId, honeytokenMints.mintId] })
    .returning({ id: honeytokenMints.id });
  return out.length;
}

export async function loadAttributions(
  tx: Tx,
  projectId: string,
  mintIds: string[],
): Promise<Map<string, HoneytokenAttribution>> {
  const out = new Map<string, HoneytokenAttribution>();
  if (mintIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(honeytokenMints)
    .where(and(eq(honeytokenMints.projectId, projectId), inArray(honeytokenMints.mintId, mintIds)));
  for (const r of rows) out.set(r.mintId, toAttribution(r));
  return out;
}

/** Record uses of minted tokens: first use (time + source) sticks, last use and count move on. */
export async function markMintsUsed(
  tx: Tx,
  projectId: string,
  uses: Array<{ mintId: string; srcIp: string; at: Date }>,
): Promise<void> {
  for (const u of uses) {
    await tx
      .update(honeytokenMints)
      .set({
        firstUsedAt: dsql`coalesce(${honeytokenMints.firstUsedAt}, ${u.at.toISOString()}::timestamptz)`,
        usedFromIp: dsql`coalesce(${honeytokenMints.usedFromIp}, ${u.srcIp}::inet)`,
        lastUsedAt: dsql`greatest(${honeytokenMints.lastUsedAt}, ${u.at.toISOString()}::timestamptz)`,
        useCount: dsql`${honeytokenMints.useCount} + 1`,
      })
      .where(and(eq(honeytokenMints.projectId, projectId), eq(honeytokenMints.mintId, u.mintId)));
  }
}
