import type { Detection, KillChainStage } from '@lxs/schema';

/** Six stages, in order. Persistence / Cred Access / Defense Evasion / C2 are ATT&CK chips, not stages. */
export const STAGE_ORDER: readonly KillChainStage[] = [
  'recon',
  'initial_access',
  'execution',
  'discovery',
  'collection',
  'exfiltration',
];

export function stageIndex(stage: KillChainStage): number {
  return STAGE_ORDER.indexOf(stage);
}

/** The later of two stages (null-safe). */
export function laterStage(
  a: KillChainStage | null,
  b: KillChainStage | null,
): KillChainStage | null {
  if (!a) return b;
  if (!b) return a;
  return stageIndex(b) > stageIndex(a) ? b : a;
}

/** Ordered, de-duplicated stages reached by a set of detections. */
export function stagesFromDetections(detections: Detection[]): KillChainStage[] {
  const seen = new Set<KillChainStage>();
  for (const d of detections) if (d.stage) seen.add(d.stage);
  return STAGE_ORDER.filter((s) => seen.has(s));
}
