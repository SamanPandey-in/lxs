import type { z } from 'zod';
import { invalid } from './errors.js';

/** Parse with a zod schema; throws a 422 envelope on failure. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw invalid(
      'Request validation failed',
      r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
