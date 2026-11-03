/**
 * The five scenarios from BREAKDOWN §12.3. These are the demo's backbone AND the
 * CI gate: what judges see is what the test suite asserts.
 *
 * The expected numbers are LOCKED. A rule change that breaks them fails CI — that is
 * deliberate, because the demo narrates these exact scores out loud.
 */
export type ScenarioName = 'noise' | 'ps-attacker' | 'honeytoken' | 'opportunistic' | 'block';

export interface ScenarioExpectation {
  name: ScenarioName;
  drives: string;
  /** Running score after each scoring step, in order. Empty when the chain is not scored stepwise. */
  progression?: number[];
  finalScore?: number;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  label?: 'noise' | 'opportunistic' | 'targeted';
  incidents: number;
  realAssetReached?: boolean;
  honeytokenUsed?: boolean;
  suppressed?: boolean;
  notifies?: boolean;
  /** ATT&CK technique ids that must appear on the incident. */
  techniques?: string[];
  stages?: string[];
}

export const SCENARIOS: Record<ScenarioName, ScenarioExpectation> = {
  noise: {
    name: 'noise',
    drives: 'scanner + fast brute force',
    progression: [5, 10, 13, 23],
    finalScore: 23,
    severity: 'low',
    label: 'noise',
    incidents: 1,
    suppressed: true,
    notifies: false,
    realAssetReached: false,
    honeytokenUsed: false,
  },
  'ps-attacker': {
    name: 'ps-attacker',
    drives: 'scan -> default creds -> shell -> read data -> hit real asset',
    progression: [5, 10, 20, 45, 50, 60, 70],
    finalScore: 100, // 120 clamped; floored Critical by R15 at targeted
    severity: 'critical',
    label: 'targeted',
    incidents: 1,
    realAssetReached: true,
    honeytokenUsed: false,
    notifies: true,
    techniques: ['T1595', 'T1110.001', 'T1078.001', 'T1059.004', 'T1083', 'T1082', 'T1005'],
    stages: ['recon', 'initial_access', 'execution', 'discovery', 'collection'],
  },
  honeytoken: {
    name: 'honeytoken',
    drives: 'read /.env -> use the planted key on the real app',
    severity: 'critical',
    label: 'targeted',
    incidents: 1,
    honeytokenUsed: true,
    notifies: true,
    techniques: ['T1552.001', 'T1078'],
  },
  opportunistic: {
    name: 'opportunistic',
    drives: 'brute force -> scripted bot commands',
    progression: [5, 15, 40, 45, 50, 65],
    finalScore: 65,
    severity: 'high',
    label: 'opportunistic',
    incidents: 1,
    notifies: false, // batched, not paged
    realAssetReached: false,
  },
  block: {
    name: 'block',
    drives: 'after ps-attacker, the analyst blocks the source',
    incidents: 1,
  },
};
