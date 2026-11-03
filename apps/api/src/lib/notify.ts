import type { StreamEventName } from '@lxs/schema';
import { sql as rootSql } from '../db/client.js';

export const STREAM_CHANNEL = 'ds_stream';

/** JSON for a pg_notify payload (8000 byte limit): `{p: projectId, t: frame name, d: data}`. */
export function streamPayload(projectId: string, type: StreamEventName, data: unknown): string {
  let json = JSON.stringify({ p: projectId, t: type, d: data });
  if (Buffer.byteLength(json) > 7500) {
    const id = (data as { id?: unknown } | null)?.id;
    json = JSON.stringify({ p: projectId, t: type, d: { id: id ?? null, truncated: true } });
  }
  return json;
}

/** Publish outside a transaction. Inside a drizzle tx use `tx.execute(sql`select pg_notify(...)`)`. */
export async function publish(
  projectId: string,
  type: StreamEventName,
  data: unknown,
): Promise<void> {
  await rootSql`select pg_notify(${STREAM_CHANNEL}, ${streamPayload(projectId, type, data)})`;
}
