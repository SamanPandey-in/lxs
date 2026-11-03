/**
 * Thin local fallback used only when `@lxs/detection` cannot be imported.
 * Same signatures as the real package; deliberately simple (a handful of rules).
 */
import type {
  DecoyEvent,
  Detection,
  IncidentLabel,
  KillChainStage,
  Severity,
  Technique,
} from '@lxs/schema';

export interface DetectionContext {
  now: Date;
  commonCredentials: Set<string>;
  criticalAssets: string[];
  existingDetections?: Detection[];
}

export interface EventTag {
  category: string;
  techniques: Technique[];
  stage: KillChainStage | null;
  ruleHints: string[];
}

export interface ChainResult {
  detections: Detection[];
  score: number;
  severity: Severity;
  label: IncidentLabel;
  stagesReached: KillChainStage[];
  realAssetReached: boolean;
  honeytokenUsed: boolean;
  rawScore: number;
  floor: Severity | null;
  preCorrelationLabel: IncidentLabel;
}

const T = (id: string, name: string, tactic: string, confidence: number): Technique => ({
  id,
  name,
  tactic,
  confidence,
});
const RANK: Severity[] = ['low', 'medium', 'high', 'critical'];

export function tagEvent(e: DecoyEvent, _ctx: DetectionContext): EventTag {
  if (!e.is_decoy) {
    const hints = e.event_type === 'honeytoken.use' ? ['R16'] : ['R15'];
    return {
      category: 'correlation',
      techniques: [],
      stage: e.event_type === 'honeytoken.use' ? 'exfiltration' : null,
      ruleHints: hints,
    };
  }
  switch (e.event_type) {
    case 'auth.attempt':
      return {
        category: 'credential',
        techniques: [T('T1110', 'Brute Force', 'credential-access', 0.6)],
        stage: 'initial_access',
        ruleHints: [],
      };
    case 'command.exec':
      return {
        category: 'execution',
        techniques: [T('T1059', 'Command and Scripting Interpreter', 'execution', 0.7)],
        stage: 'execution',
        ruleHints: [],
      };
    case 'file.download':
    case 'file.upload':
      return {
        category: 'collection',
        techniques: [T('T1105', 'Ingress Tool Transfer', 'command-and-control', 0.6)],
        stage: 'collection',
        ruleHints: [],
      };
    default:
      return {
        category: 'recon',
        techniques: [T('T1595', 'Active Scanning', 'reconnaissance', 0.6)],
        stage: 'recon',
        ruleHints: ['R01'],
      };
  }
}

const det = (
  rule_id: string,
  points: number,
  reason: string,
  stage: KillChainStage | null,
  floor: Severity | null,
  ids: string[],
  techniques: Technique[] = [],
): Detection => ({
  rule_id,
  points,
  reason,
  techniques,
  stage,
  floor,
  evidence_event_ids: ids,
});

export function evaluateChain(events: DecoyEvent[], ctx: DetectionContext): ChainResult {
  const d: Detection[] = [];
  const ids = (f: (e: DecoyEvent) => boolean) =>
    events
      .filter(f)
      .map((e) => e.id)
      .slice(0, 20);
  const any = (f: (e: DecoyEvent) => boolean) => events.some(f);

  if (any((e) => e.is_decoy))
    d.push(
      det(
        'R01',
        5,
        'Touched a decoy',
        'recon',
        null,
        ids((e) => e.is_decoy),
      ),
    );
  const fails = events.filter(
    (e) => e.event_type === 'auth.attempt' && e.outcome === 'failure',
  ).length;
  if (fails >= 5)
    d.push(
      det(
        'R04',
        10,
        `${fails} failed logins`,
        'initial_access',
        null,
        ids((e) => e.event_type === 'auth.attempt'),
      ),
    );
  const login = events.find((e) => e.event_type === 'auth.attempt' && e.outcome === 'success');
  const common =
    !!login &&
    ctx.commonCredentials.size > 0 &&
    ctx.commonCredentials.has(`${login.username}/${login.password_clear}`);
  if (login)
    d.push(
      det(
        'R06',
        25,
        `Logged in as ${login.username ?? 'unknown'}`,
        'initial_access',
        null,
        [login.id],
        [T('T1078', 'Valid Accounts', 'initial-access', 0.8)],
      ),
    );
  const cmds = events.filter((e) => e.event_type === 'command.exec');
  if (cmds.length >= 3)
    d.push(
      det(
        'R07',
        5,
        `${cmds.length} commands executed`,
        'execution',
        null,
        cmds.map((e) => e.id).slice(0, 20),
      ),
    );
  const tool = cmds.find((e) => /\b(wget|curl)\b.*https?:\/\//i.test(e.command ?? ''));
  if (tool)
    d.push(
      det(
        'R09',
        15,
        'Tool transfer attempt',
        'execution',
        null,
        [tool.id],
        [T('T1105', 'Ingress Tool Transfer', 'command-and-control', 0.8)],
      ),
    );
  const asset = events.find(
    (e) => !e.is_decoy && (e.event_type === 'asset.access' || e.event_type === 'prod.auth'),
  );
  const honey = events.find((e) => e.event_type === 'honeytoken.use');
  const pre: IncidentLabel = login
    ? common
      ? 'opportunistic'
      : 'targeted'
    : cmds.length
      ? 'opportunistic'
      : 'noise';
  if (asset)
    d.push(
      det(
        'R15',
        pre === 'targeted' ? 50 : 20,
        `Source touched real asset ${asset.asset_name ?? asset.dst_service}`,
        null,
        pre === 'targeted' ? 'critical' : 'high',
        [asset.id],
      ),
    );
  if (honey) d.push(det('R16', 50, 'Honeytoken used', 'exfiltration', 'critical', [honey.id]));

  const raw = d.reduce((s, x) => s + x.points, 0);
  const score = Math.min(100, raw);
  const bySc: Severity =
    score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';
  const floor = d.reduce<Severity | null>(
    (b, x) => (x.floor && (!b || RANK.indexOf(x.floor) > RANK.indexOf(b)) ? x.floor : b),
    null,
  );
  const severity = floor && RANK.indexOf(floor) > RANK.indexOf(bySc) ? floor : bySc;
  const label: IncidentLabel =
    asset || honey
      ? pre === 'noise'
        ? 'opportunistic'
        : pre === 'targeted' || honey
          ? 'targeted'
          : pre
      : pre;
  const stages = [...new Set(d.map((x) => x.stage).filter((s): s is KillChainStage => !!s))];
  return {
    detections: d,
    score,
    severity,
    label,
    stagesReached: stages,
    realAssetReached: !!asset,
    honeytokenUsed: !!honey,
    rawScore: raw,
    floor,
    preCorrelationLabel: pre,
  };
}
