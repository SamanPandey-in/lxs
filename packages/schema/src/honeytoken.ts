import { z } from 'zod';

export const HoneytokenKind = z.enum(['api_key', 'aws_key', 'db_url', 'jwt', 'ssh_key']);
export type HoneytokenKind = z.infer<typeof HoneytokenKind>;

export const Honeytoken = z.object({
  id: z.string().max(64),
  kind: HoneytokenKind,
  value_sha256: z.string().length(64),
  planted_in: z.array(z.string()),
  created_at: z.string().datetime(),
  first_used_at: z.string().datetime().nullable().optional(),
});
export type Honeytoken = z.infer<typeof Honeytoken>;
