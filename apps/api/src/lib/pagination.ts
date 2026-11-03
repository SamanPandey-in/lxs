import { z } from 'zod';

export const LimitQuery = z.coerce.number().int().min(1).max(500).default(50);

export const encodeCursor = (v: string): string => Buffer.from(v, 'utf8').toString('base64url');
export const decodeCursor = (c: string | undefined | null): string | null => {
  if (!c) return null;
  try {
    return Buffer.from(c, 'base64url').toString('utf8');
  } catch {
    return null;
  }
};

/** Offset cursors for the small, human-scale lists (incidents, attackers, audit...). */
export const encodeOffset = (n: number): string => encodeCursor(`o:${n}`);
export const decodeOffset = (c: string | undefined | null): number => {
  const raw = decodeCursor(c);
  if (!raw?.startsWith('o:')) return 0;
  const n = Number(raw.slice(2));
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

export function pageOf<T>(
  rows: T[],
  limit: number,
  offset: number,
): { items: T[]; next_cursor: string | null } {
  const hasMore = rows.length > limit;
  return {
    items: hasMore ? rows.slice(0, limit) : rows,
    next_cursor: hasMore ? encodeOffset(offset + limit) : null,
  };
}
