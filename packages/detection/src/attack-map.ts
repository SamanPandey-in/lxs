import type { Technique } from '@lxs/schema';

/**
 * MITRE ATT&CK techniques referenced by the R01-R19 rule table (BREAKDOWN 7.6).
 * `confidence` is the default; individual rules may override it (e.g. T1078 is 0.6 for R15 and 0.95 for R16).
 */
export const ATTACK_MAP: Record<string, Technique> = {
  T1595: { id: 'T1595', name: 'Active Scanning', tactic: 'reconnaissance', confidence: 0.7 },
  'T1595.002': {
    id: 'T1595.002',
    name: 'Vulnerability Scanning',
    tactic: 'reconnaissance',
    confidence: 0.8,
  },
  'T1595.003': {
    id: 'T1595.003',
    name: 'Wordlist Scanning',
    tactic: 'reconnaissance',
    confidence: 0.8,
  },
  T1046: { id: 'T1046', name: 'Network Service Discovery', tactic: 'discovery', confidence: 0.8 },
  'T1110.001': {
    id: 'T1110.001',
    name: 'Password Guessing',
    tactic: 'credential-access',
    confidence: 0.9,
  },
  T1190: {
    id: 'T1190',
    name: 'Exploit Public-Facing Application',
    tactic: 'initial-access',
    confidence: 0.7,
  },
  T1078: { id: 'T1078', name: 'Valid Accounts', tactic: 'initial-access', confidence: 0.6 },
  'T1078.001': {
    id: 'T1078.001',
    name: 'Default Accounts',
    tactic: 'initial-access',
    confidence: 0.9,
  },
  'T1059.004': { id: 'T1059.004', name: 'Unix Shell', tactic: 'execution', confidence: 0.9 },
  T1083: {
    id: 'T1083',
    name: 'File and Directory Discovery',
    tactic: 'discovery',
    confidence: 0.8,
  },
  T1033: { id: 'T1033', name: 'System Owner/User Discovery', tactic: 'discovery', confidence: 0.8 },
  T1082: {
    id: 'T1082',
    name: 'System Information Discovery',
    tactic: 'discovery',
    confidence: 0.8,
  },
  T1057: { id: 'T1057', name: 'Process Discovery', tactic: 'discovery', confidence: 0.8 },
  'T1087.001': {
    id: 'T1087.001',
    name: 'Local Account Discovery',
    tactic: 'discovery',
    confidence: 0.8,
  },
  T1105: {
    id: 'T1105',
    name: 'Ingress Tool Transfer',
    tactic: 'command-and-control',
    confidence: 0.8,
  },
  'T1053.003': { id: 'T1053.003', name: 'Cron', tactic: 'persistence', confidence: 0.8 },
  'T1098.004': {
    id: 'T1098.004',
    name: 'SSH Authorized Keys',
    tactic: 'persistence',
    confidence: 0.8,
  },
  T1005: { id: 'T1005', name: 'Data from Local System', tactic: 'collection', confidence: 0.8 },
  'T1552.001': {
    id: 'T1552.001',
    name: 'Credentials In Files',
    tactic: 'credential-access',
    confidence: 0.8,
  },
  'T1070.003': {
    id: 'T1070.003',
    name: 'Clear Command History',
    tactic: 'defense-evasion',
    confidence: 0.9,
  },
  T1041: {
    id: 'T1041',
    name: 'Exfiltration Over C2 Channel',
    tactic: 'exfiltration',
    confidence: 0.6,
  },
  T1090: { id: 'T1090', name: 'Proxy', tactic: 'command-and-control', confidence: 0.8 },
};

/** Build a Technique from the map, optionally overriding the confidence for a specific rule. */
export function tech(id: string, confidence?: number): Technique {
  const base = ATTACK_MAP[id];
  if (!base) throw new Error(`Unknown ATT&CK technique ${id}`);
  return confidence === undefined ? { ...base } : { ...base, confidence };
}

/** Merge technique lists by id, keeping the highest confidence. Order of first appearance is kept. */
export function mergeTechniques(...lists: Technique[][]): Technique[] {
  const out = new Map<string, Technique>();
  for (const list of lists) {
    for (const t of list) {
      const prev = out.get(t.id);
      if (!prev || t.confidence > prev.confidence) out.set(t.id, t);
    }
  }
  return [...out.values()];
}
