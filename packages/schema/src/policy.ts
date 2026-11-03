import { z } from 'zod';

/** Pull-only control channel: agents poll this; the platform never dials into customer infra. */
export const BlocklistEntry = z.object({
  ip: z.string(),
  reason: z.string().max(256).optional(),
  expires_at: z.string().datetime().nullable().optional(),
});
export type BlocklistEntry = z.infer<typeof BlocklistEntry>;

export const AgentPolicy = z.object({
  policy_version: z.number().int().nonnegative(),
  blocklist: z.array(BlocklistEntry),
  watchlist: z.array(z.string()), // IPs the SDK should report real-asset hits for
  block_ttl_seconds: z.number().int().positive().default(3600),
  poll_interval_seconds: z.number().int().positive().default(10),
});
export type AgentPolicy = z.infer<typeof AgentPolicy>;

export const AgentRegister = z.object({
  hostname: z.string().max(256),
  agent_version: z.string().max(32),
  sdk_version: z.string().max(32).optional(),
  manifest: z.object({
    decoys: z.array(
      z.object({
        decoy_key: z.string().max(64),
        type: z.string().max(32),
        mount: z.string().max(256),
        persona: z.string().max(64).optional(),
        posture: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
  }),
});
export type AgentRegister = z.infer<typeof AgentRegister>;

export const AgentHeartbeat = z.object({
  sensor_id: z.string(),
  applied_policy_version: z.number().int().nonnegative(),
  stats: z.record(z.string(), z.number()).optional(),
  decoys: z.array(z.object({ decoy_key: z.string(), status: z.string() })).optional(),
});
export type AgentHeartbeat = z.infer<typeof AgentHeartbeat>;

export const ContainmentReport = z.object({
  sensor_id: z.string(),
  passed: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string(),
      passed: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
});
export type ContainmentReport = z.infer<typeof ContainmentReport>;
