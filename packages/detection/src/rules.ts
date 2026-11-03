import type { DecoyEvent, Detection, KillChainStage, Severity, Technique } from '@lxs/schema';
import { mergeTechniques, tech } from './attack-map.js';
import { laterStage } from './killchain.js';

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

export interface DetectionContext {
  /** Injected clock. The engine never reads the system clock itself. */
  now: Date;
  /** Bare passwords and "user/password" pairs from data/wordlists/common-creds.txt. */
  commonCredentials: Set<string>;
  /** Names ("Payments API") or path patterns ("/api/payments/*") of assets declared critical. */
  criticalAssets: string[];
  /** Detections already stored for this incident; once-only rules and floors stay sticky. */
  existingDetections?: Detection[];
}

/** Parse the text of common-creds.txt (pure; the caller does the file I/O). */
export function parseCommonCredentials(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    out.add(line);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Rule table (BREAKDOWN 7.6)                                                 */
/* -------------------------------------------------------------------------- */

export interface RuleMeta {
  id: string;
  family: string;
  signal: string;
  points: number; // nominal points per firing (R15 is label-dependent, see correlate.ts)
  stage: KillChainStage | null;
}

export const RULES: Readonly<Record<string, RuleMeta>> = {
  R01: { id: 'R01', family: 'recon', signal: 'Touched a decoy', points: 5, stage: 'recon' },
  R02: {
    id: 'R02',
    family: 'recon',
    signal: 'Sweep: >= 3 distinct decoys/paths in 60 s',
    points: 5,
    stage: 'recon',
  },
  R03: {
    id: 'R03',
    family: 'recon',
    signal: 'Known scanner UA / SSH client banner',
    points: 3,
    stage: 'recon',
  },
  R04: {
    id: 'R04',
    family: 'credential',
    signal: '>= 5 failed logins in 60 s',
    points: 10,
    stage: 'initial_access',
  },
  R05: {
    id: 'R05',
    family: 'exploit',
    signal: 'SQLi / XSS / traversal / command injection',
    points: 10,
    stage: 'initial_access',
  },
  R06: {
    id: 'R06',
    family: 'access',
    signal: 'Login with default/weak credentials',
    points: 25,
    stage: 'initial_access',
  },
  R07: {
    id: 'R07',
    family: 'execution',
    signal: 'Session with >= 3 commands',
    points: 5,
    stage: 'execution',
  },
  R08: {
    id: 'R08',
    family: 'discovery',
    signal: 'Discovery command',
    points: 5,
    stage: 'discovery',
  },
  R09: { id: 'R09', family: 'execution', signal: 'Tool transfer', points: 15, stage: 'execution' },
  R10: {
    id: 'R10',
    family: 'persistence',
    signal: 'Persistence attempt',
    points: 20,
    stage: 'execution',
  },
  R11: {
    id: 'R11',
    family: 'collection',
    signal: 'Accessed decoy data / honeytoken file',
    points: 10,
    stage: 'collection',
  },
  R12: {
    id: 'R12',
    family: 'spread',
    signal: 'Same source on >= 2 decoy types (label signal)',
    points: 0,
    stage: null,
  },
  R13: {
    id: 'R13',
    family: 'behaviour',
    signal: 'Human cadence (label signal)',
    points: 0,
    stage: null,
  },
  R14: {
    id: 'R14',
    family: 'behaviour',
    signal: 'Revisit after > 10 min idle',
    points: 5,
    stage: null,
  },
  R15: {
    id: 'R15',
    family: 'correlation',
    signal: 'Watched source touched a real asset',
    points: 0,
    stage: null,
  },
  R16: {
    id: 'R16',
    family: 'honeytoken',
    signal: 'Honeytoken used',
    points: 50,
    stage: 'exfiltration',
  },
  R17: {
    id: 'R17',
    family: 'evasion',
    signal: 'History / log clearing',
    points: 10,
    stage: 'execution',
  },
  R18: {
    id: 'R18',
    family: 'exfil',
    signal: 'Decoy data left the decoy (tag only)',
    points: 0,
    stage: 'exfiltration',
  },
  R19: {
    id: 'R19',
    family: 'tunnelling',
    signal: 'SSH port-forwarding request',
    points: 10,
    stage: 'execution',
  },
};

export const WINDOW_60S = 60_000;
export const IDLE_REVISIT_MS = 10 * 60_000;
export const HUMAN_MIN_MEDIAN_GAP_MS = 1_500;

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

export function eventTime(e: DecoyEvent): number {
  return Date.parse(e.timestamp);
}

/** Stable chronological sort (ties keep input order). */
export function sortEvents(events: DecoyEvent[]): DecoyEvent[] {
  return events
    .map((e, i) => ({ e, i, t: eventTime(e) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.e);
}

export function det(
  id: string,
  points: number,
  reason: string,
  techniques: Technique[],
  evidence: string[],
  opts: { stage?: KillChainStage | null; floor?: Severity | null } = {},
): Detection {
  return {
    rule_id: id,
    points,
    reason,
    techniques,
    stage: opts.stage === undefined ? (RULES[id]?.stage ?? null) : opts.stage,
    floor: opts.floor ?? null,
    evidence_event_ids: evidence.slice(0, 20),
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function pathOf(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Asset path from `dst_service` ("app:/api/payments" -> "/api/payments"). */
export function servicePath(e: DecoyEvent): string {
  const i = e.dst_service.indexOf(':');
  return i === -1 ? e.dst_service : e.dst_service.slice(i + 1);
}

/** True when the password the source used is in the bundled common-credentials list. */
export function isCommonCredential(e: DecoyEvent, ctx: DetectionContext): boolean {
  const pw = e.password_clear;
  if (pw === undefined || pw === '') return false;
  if (ctx.commonCredentials.has(pw)) return true;
  return e.username !== undefined && ctx.commonCredentials.has(`${e.username}/${pw}`);
}

/* -------------------------------------------------------------------------- */
/* Signature matching                                                         */
/* -------------------------------------------------------------------------- */

export const SCANNER_RE =
  /(?:^|[^a-z])(nmap|masscan|zgrab2?|sqlmap|nikto|gobuster|nuclei|hydra|libssh)/i;

export function scannerMatch(e: DecoyEvent): string | null {
  for (const s of [e.user_agent, e.client_banner]) {
    if (!s) continue;
    const m = SCANNER_RE.exec(s);
    if (m?.[1]) return m[1].toLowerCase();
  }
  return null;
}

export type ExploitType = 'sqli' | 'xss' | 'traversal' | 'cmdi';

const SQLI_RE =
  /(\bunion\b[\s\S]{0,40}\bselect\b|\bor\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+|'\s*or\s*'|'\s*--|;\s*drop\s+table|\bsleep\s*\(\s*\d+|information_schema|benchmark\s*\(|\bwaitfor\s+delay\b)/i;
const XSS_RE =
  /(<\s*script|<\s*img[^>]+onerror|\bonerror\s*=|\bonload\s*=|javascript\s*:|<\s*svg[^>]*onload)/i;
const TRAVERSAL_RE = /(\.\.[\\/]|\.\.%2f|%2e%2e[\\/%]|\/etc\/(passwd|shadow)|\bwin\.ini\b)/i;
const CMDI_RE =
  /(;|\|\||&&|\||`|\$\()\s*(cat|ls|id|whoami|uname|wget|curl|nc|ncat|bash|sh|ping|sleep|python|perl)\b|\(\)\s*\{[^}]*\}\s*;/i;

/** Exploit signatures in a decoy request (url, body excerpt, submitted username). */
export function exploitTypes(e: DecoyEvent): ExploitType[] {
  if (!e.is_decoy) return [];
  if (
    e.event_type !== 'http.request' &&
    e.event_type !== 'auth.attempt' &&
    e.event_type !== 'db.command'
  )
    return [];
  const raw = [e.url, e.payload, e.username, e.command]
    .filter((s): s is string => !!s)
    .join(' \n ');
  if (!raw) return [];
  const texts = [raw, safeDecode(raw)];
  const out: ExploitType[] = [];
  if (texts.some((t) => SQLI_RE.test(t))) out.push('sqli');
  if (texts.some((t) => XSS_RE.test(t))) out.push('xss');
  if (texts.some((t) => TRAVERSAL_RE.test(t))) out.push('traversal');
  if (texts.some((t) => CMDI_RE.test(t))) out.push('cmdi');
  return out;
}

export const EXPLOIT_LABEL: Record<ExploitType, string> = {
  sqli: 'SQL injection',
  xss: 'Cross-site scripting',
  traversal: 'Path traversal',
  cmdi: 'Command injection',
};

/* -------------------------------------------------------------------------- */
/* Command analysis                                                           */
/* -------------------------------------------------------------------------- */

export interface CommandFacts {
  discovery: { key: string; technique: string }[];
  transfer: boolean;
  persistence: string[]; // technique ids
  evasion: boolean;
  baitRead: boolean;
  baitSecret: boolean;
}

const READ_VERBS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'scp',
  'sftp',
  'base64',
  'cp',
  'tar',
  'zip',
  'gzip',
  'strings',
  'xxd',
  'nano',
  'vi',
  'vim',
  'grep',
  'rsync',
  'get',
  'mysqldump',
  'pg_dump',
]);
const TRANSFER_CMDS = new Set(['wget', 'curl', 'tftp', 'ftpget', 'scp']);
const BAIT_RE =
  /(customer_data|backup\.sql|\.sql\b|\.csv\b|\/srv\/exports|\.env\b|id_rsa|credentials|acme\.json|secrets?\b)/i;
const BAIT_SECRET_RE = /(\.env\b|credential|id_rsa|acme\.json|secret)/i;
const EVASION_RES = [
  /\bhistory\s+-[cw]\b/i,
  /\bunset\s+HISTFILE\b/i,
  /\bHISTFILE\s*=\s*\/dev\/null\b/i,
  /\bHISTSIZE\s*=\s*0\b/i,
  /\brm\s+(-\w+\s+)*\S*\/var\/log\b/i,
  /\brm\s+(-\w+\s+)*\S*bash_history\b/i,
  />\s*\S*bash_history\b/i,
  /\bshred\b/i,
];

export function splitSegments(cmd: string): string[] {
  return cmd
    .split(/;|&&|\|\||\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normaliseSegment(seg: string): string {
  let s = seg.trim();
  for (;;) {
    const next = s
      .replace(/^(sudo|nohup|time|env)\s+(-\S+\s+)*/i, '')
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

function baseName(tok: string): string {
  const i = tok.lastIndexOf('/');
  return (i === -1 ? tok : tok.slice(i + 1)).toLowerCase();
}

export function analyzeCommand(cmd: string | undefined, isDb = false): CommandFacts {
  const facts: CommandFacts = {
    discovery: [],
    transfer: false,
    persistence: [],
    evasion: false,
    baitRead: false,
    baitSecret: false,
  };
  if (!cmd) return facts;
  if (EVASION_RES.some((re) => re.test(cmd))) facts.evasion = true;
  const seenDisc = new Set<string>();
  const addDisc = (key: string, technique: string) => {
    if (!seenDisc.has(key)) {
      seenDisc.add(key);
      facts.discovery.push({ key, technique });
    }
  };
  const addPersist = (id: string) => {
    if (!facts.persistence.includes(id)) facts.persistence.push(id);
  };

  for (const rawSeg of splitSegments(cmd)) {
    const seg = normaliseSegment(rawSeg);
    if (!seg) continue;
    const tokens = seg.split(/\s+/);
    const c0 = baseName(tokens[0] ?? '');

    if (isDb) {
      if (c0 === 'info') addDisc('INFO', 'T1082');
      else if (c0 === 'keys' && /^keys\s+\*/i.test(seg)) addDisc('KEYS *', 'T1083');
      if (c0 === 'config' && /^config\s+set\s+dir\b/i.test(seg))
        addPersist(/\.ssh/i.test(seg) ? 'T1098.004' : 'T1053.003');
      if (c0 === 'replicaof' || c0 === 'slaveof') addPersist('T1053.003');
      if (c0 === 'module' && /^module\s+load\b/i.test(seg)) addPersist('T1053.003');
      continue;
    }

    switch (c0) {
      case 'ls':
        addDisc('ls', 'T1083');
        break;
      case 'pwd':
        addDisc('pwd', 'T1083');
        break;
      case 'whoami':
        addDisc('whoami', 'T1033');
        break;
      case 'id':
        addDisc('id', 'T1033');
        break;
      case 'uname':
        addDisc('uname', 'T1082');
        break;
      case 'ps':
        addDisc('ps', 'T1057');
        break;
      default:
        break;
    }
    if (c0 === 'cat' && /\/etc\/passwd\b/.test(seg)) addDisc('cat /etc/passwd', 'T1087.001');

    if (TRANSFER_CMDS.has(c0)) facts.transfer = true;
    if (c0 === 'crontab') addPersist('T1053.003');
    if (
      /\bauthorized_keys\b/i.test(seg) &&
      /(>|\btee\b|\becho\b|\bcp\b|\bmv\b|\bsed\b|\bchattr\b|\bprintf\b|\bssh-copy-id\b)/i.test(seg)
    ) {
      addPersist('T1098.004');
    }
    if (READ_VERBS.has(c0) && BAIT_RE.test(seg)) {
      facts.baitRead = true;
      if (BAIT_SECRET_RE.test(seg)) facts.baitSecret = true;
    }
  }
  return facts;
}

function isCommandEvent(e: DecoyEvent): boolean {
  return e.event_type === 'command.exec' || e.event_type === 'db.command';
}

function factsOf(e: DecoyEvent): CommandFacts {
  return analyzeCommand(e.command, e.event_type === 'db.command' || e.sensor === 'redis');
}

function isExport2xx(e: DecoyEvent): boolean {
  return (
    e.is_decoy &&
    e.event_type === 'http.request' &&
    /export|download|dump/i.test(pathOf(e.url)) &&
    e.status_code !== undefined &&
    e.status_code >= 200 &&
    e.status_code < 300
  );
}

/** Bait served by a web decoy (R11 + R18 source). */
function isBaitServed(e: DecoyEvent): boolean {
  return (
    e.is_decoy &&
    e.event_type === 'file.download' &&
    e.sensor === 'web' &&
    (e.status_code === undefined || e.status_code < 400)
  );
}

/* -------------------------------------------------------------------------- */
/* Cadence (R13)                                                              */
/* -------------------------------------------------------------------------- */

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length === 0) return 0;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * Human cadence: >= 3 interactive actions (shell / db commands), median gap >= 1.5 s,
 * and variable gaps (a metronome-like script is not human).
 */
export function humanCadence(commands: DecoyEvent[]): { human: boolean; evidence: string[] } {
  if (commands.length < 3) return { human: false, evidence: [] };
  const times = commands.map(eventTime);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] as number) - (times[i - 1] as number));
  const med = median(gaps);
  const spread = Math.max(...gaps) - Math.min(...gaps);
  const human = med >= HUMAN_MIN_MEDIAN_GAP_MS && spread >= Math.max(250, 0.15 * med);
  return { human, evidence: commands.slice(0, 5).map((e) => e.id) };
}

/* -------------------------------------------------------------------------- */
/* Decoy-activity rules (everything except R15 / R16)                         */
/* -------------------------------------------------------------------------- */

export interface DecoyFacts {
  hasSuccessLogin: boolean;
  /** A successful decoy login whose credentials are NOT in the common list. */
  uncommonSuccessLogin: boolean;
}

export function decoyFacts(events: DecoyEvent[], ctx: DetectionContext): DecoyFacts {
  let hasSuccessLogin = false;
  let uncommonSuccessLogin = false;
  for (const e of events) {
    if (!e.is_decoy || e.event_type !== 'auth.attempt' || e.outcome !== 'success') continue;
    hasSuccessLogin = true;
    if (!isCommonCredential(e, ctx)) uncommonSuccessLogin = true;
  }
  return { hasSuccessLogin, uncommonSuccessLogin };
}

/** Evaluate R01-R14 and R17-R19 over chronologically sorted events. */
export function runDecoyRules(sorted: DecoyEvent[], ctx: DetectionContext): Detection[] {
  const out: Detection[] = [];
  const dec = sorted.filter((e) => e.is_decoy);
  if (dec.length === 0) return out;

  // R01: touched any decoy.
  const first = dec[0] as DecoyEvent;
  out.push(
    det(
      'R01',
      5,
      `Touched decoy ${first.decoy_id ?? first.dst_service}`,
      [tech('T1595', 0.7)],
      [first.id],
    ),
  );

  // R02: >= 3 distinct decoys/paths within 60 s (two-pointer window over dst_service).
  {
    const counts = new Map<string, number>();
    let lo = 0;
    for (let hi = 0; hi < dec.length; hi++) {
      const h = dec[hi] as DecoyEvent;
      counts.set(h.dst_service, (counts.get(h.dst_service) ?? 0) + 1);
      while (eventTime(h) - eventTime(dec[lo] as DecoyEvent) > WINDOW_60S) {
        const l = dec[lo] as DecoyEvent;
        const c = (counts.get(l.dst_service) ?? 1) - 1;
        if (c <= 0) counts.delete(l.dst_service);
        else counts.set(l.dst_service, c);
        lo++;
      }
      if (counts.size >= 3) {
        const seen = new Set<string>();
        const ev: string[] = [];
        for (let i = lo; i <= hi; i++) {
          const e = dec[i] as DecoyEvent;
          if (!seen.has(e.dst_service)) {
            seen.add(e.dst_service);
            ev.push(e.id);
          }
        }
        out.push(
          det(
            'R02',
            5,
            `Sweep: ${counts.size} distinct decoys/paths within 60 s`,
            [tech('T1595.003', 0.8), tech('T1046', 0.8)],
            ev,
          ),
        );
        break;
      }
    }
  }

  // R03: known scanner UA or SSH client banner.
  {
    const hits = dec.filter((e) => scannerMatch(e) !== null);
    if (hits.length) {
      const names = [...new Set(hits.map((e) => scannerMatch(e) as string))];
      out.push(
        det(
          'R03',
          3,
          `Known scanner signature: ${names.join(', ')}`,
          [tech('T1595.002', 0.8)],
          hits.map((e) => e.id),
        ),
      );
    }
  }

  // R04: >= 5 failed logins within 60 s (weighted by event.count).
  {
    const fails = dec.filter((e) => e.event_type === 'auth.attempt' && e.outcome === 'failure');
    let lo = 0;
    let sum = 0;
    for (let hi = 0; hi < fails.length; hi++) {
      const h = fails[hi] as DecoyEvent;
      sum += h.count;
      while (eventTime(h) - eventTime(fails[lo] as DecoyEvent) > WINDOW_60S) {
        sum -= (fails[lo] as DecoyEvent).count;
        lo++;
      }
      if (sum >= 5) {
        out.push(
          det(
            'R04',
            10,
            `${sum} failed logins within 60 s`,
            [tech('T1110.001', 0.9)],
            fails.slice(lo, hi + 1).map((e) => e.id),
          ),
        );
        break;
      }
    }
  }

  // R05: exploit signatures, +10 per type (cap enforced when merging).
  {
    const byType = new Map<ExploitType, string[]>();
    for (const e of dec) {
      for (const t of exploitTypes(e)) {
        const list = byType.get(t) ?? [];
        list.push(e.id);
        byType.set(t, list);
      }
    }
    for (const t of ['sqli', 'xss', 'traversal', 'cmdi'] as const) {
      const ev = byType.get(t);
      if (ev)
        out.push(
          det(
            'R05',
            10,
            `${EXPLOIT_LABEL[t]} signature in a decoy request`,
            [tech('T1190', 0.7)],
            ev,
          ),
        );
    }
  }

  const commands = dec.filter(isCommandEvent);

  // R06: successful login with default/weak credentials.
  {
    const hit = dec.find(
      (e) =>
        e.event_type === 'auth.attempt' && e.outcome === 'success' && isCommonCredential(e, ctx),
    );
    if (hit) {
      out.push(
        det(
          'R06',
          25,
          `Logged in to ${hit.decoy_id ?? hit.dst_service} with default/weak credentials (${hit.username ?? '?'})`,
          [tech('T1078.001', 0.9)],
          [hit.id],
        ),
      );
    }
  }

  // R07: session with >= 3 commands.
  {
    const shell = commands.filter((e) => e.event_type === 'command.exec');
    const bySession = new Map<string, DecoyEvent[]>();
    for (const e of shell) {
      const k = e.session_id ?? `${e.src_ip}|${e.decoy_id ?? ''}`;
      const list = bySession.get(k) ?? [];
      list.push(e);
      bySession.set(k, list);
    }
    for (const list of bySession.values()) {
      const n = list.reduce((s, e) => s + e.count, 0);
      if (n >= 3) {
        out.push(
          det(
            'R07',
            5,
            `Session ran ${n} commands`,
            [tech('T1059.004', 0.9)],
            list.map((e) => e.id),
          ),
        );
        break;
      }
    }
  }

  // R08: discovery commands, +5 per distinct (cap enforced when merging).
  {
    const seen = new Set<string>();
    for (const e of commands) {
      for (const d of factsOf(e).discovery) {
        if (seen.has(d.key)) continue;
        seen.add(d.key);
        out.push(det('R08', 5, `Discovery command: ${d.key}`, [tech(d.technique, 0.8)], [e.id]));
      }
    }
  }

  // R09: tool transfer (wget/curl/tftp/scp, or an uploaded/downloaded file inside a decoy shell).
  {
    const hit =
      commands.find((e) => factsOf(e).transfer) ??
      dec.find(
        (e) =>
          (e.event_type === 'file.download' && e.sensor !== 'web') ||
          e.event_type === 'file.upload',
      );
    if (hit) {
      out.push(
        det(
          'R09',
          15,
          `Tool transfer${hit.url ? ` from ${hit.url}` : hit.command ? `: ${hit.command.slice(0, 80)}` : ''}`,
          [tech('T1105', 0.8)],
          [hit.id],
        ),
      );
    }
  }

  // R10: persistence.
  {
    const ev: string[] = [];
    const ids: string[] = [];
    for (const e of commands) {
      const p = factsOf(e).persistence;
      if (p.length) {
        ev.push(e.id);
        for (const id of p) if (!ids.includes(id)) ids.push(id);
      }
    }
    if (ev.length) {
      out.push(
        det(
          'R10',
          20,
          'Persistence attempt (cron / authorized_keys / Redis config abuse)',
          ids.map((id) => tech(id, 0.8)),
          ev,
        ),
      );
    }
  }

  // R11 / R18: decoy data accessed / left the decoy.
  {
    const ev: string[] = [];
    let secret = false;
    const exfil: string[] = [];
    for (const e of dec) {
      if (e.event_type === 'honeytoken.read') {
        ev.push(e.id);
        secret = true;
      } else if (isBaitServed(e)) {
        ev.push(e.id);
        exfil.push(e.id);
        if (BAIT_SECRET_RE.test(`${e.url ?? ''} ${e.file_name ?? ''}`)) secret = true;
      } else if (isExport2xx(e)) {
        ev.push(e.id);
        exfil.push(e.id);
      } else if (isCommandEvent(e)) {
        const f = factsOf(e);
        if (f.baitRead) {
          ev.push(e.id);
          exfil.push(e.id);
          if (f.baitSecret) secret = true;
        }
      }
    }
    if (ev.length) {
      const techs = [tech('T1005', 0.8)];
      if (secret) techs.push(tech('T1552.001', 0.8));
      out.push(det('R11', 10, 'Accessed decoy data / honeytoken file', techs, ev));
    }
    if (exfil.length) {
      out.push(
        det(
          'R18',
          0,
          'Decoy data left the decoy (bait file served or read over the session)',
          [tech('T1041', 0.6)],
          exfil,
        ),
      );
    }
  }

  // R12: same source on >= 2 decoy types (label signal, 0 points).
  {
    const types = new Set(dec.map((e) => e.sensor));
    if (types.size >= 2) {
      out.push(
        det(
          'R12',
          0,
          `Same source on ${types.size} decoy types (${[...types].sort().join(', ')})`,
          [],
          dec.slice(0, 5).map((e) => e.id),
        ),
      );
    }
  }

  // R13: human cadence (label signal, 0 points).
  {
    const h = humanCadence(commands);
    if (h.human)
      out.push(det('R13', 0, 'Human cadence: variable gaps, median >= 1.5 s', [], h.evidence));
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as DecoyEvent;
    const cur = sorted[i] as DecoyEvent;
    const gap = eventTime(cur) - eventTime(prev);
    if (gap > IDLE_REVISIT_MS) {
      out.push(
        det(
          'R14',
          5,
          `Revisit after ${Math.round(gap / 60_000)} min idle (at ${cur.timestamp})`,
          [],
          [cur.id],
        ),
      );
    }
  }

  // R17: defence evasion.
  {
    const hit = commands.filter((e) => factsOf(e).evasion);
    if (hit.length)
      out.push(
        det(
          'R17',
          10,
          'Cleared history / logs',
          [tech('T1070.003', 0.9)],
          hit.map((e) => e.id),
        ),
      );
  }

  // R19: SSH port-forwarding request.
  {
    const hits = dec.filter((e) => e.event_type === 'proxy.attempt');
    if (hits.length) {
      const h = hits[0] as DecoyEvent;
      out.push(
        det(
          'R19',
          10,
          `SSH port-forwarding request to ${h.dst_service}`,
          [tech('T1090', 0.8)],
          hits.map((e) => e.id),
        ),
      );
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Per-event tagging                                                          */
/* -------------------------------------------------------------------------- */

export interface EventTag {
  category: string;
  techniques: Technique[];
  stage: KillChainStage | null;
  ruleHints: string[];
}

export function tagEvent(event: DecoyEvent, ctx: DetectionContext): EventTag {
  const hints: string[] = [];
  const techs: Technique[][] = [];
  let stage: KillChainStage | null = null;
  let category = 'session';
  const hint = (id: string) => {
    if (!hints.includes(id)) hints.push(id);
  };

  if (!event.is_decoy) {
    category = 'correlation';
    if (event.event_type === 'honeytoken.use') {
      category = 'honeytoken';
      hint('R16');
      techs.push([tech('T1078', 0.95), tech('T1552.001', 0.95)]);
      stage = 'exfiltration';
    } else if (
      event.event_type === 'asset.access' ||
      event.event_type === 'prod.auth' ||
      event.event_type === 'prod.firewall'
    ) {
      hint('R15');
      if (event.event_type === 'prod.auth' && event.outcome === 'success')
        techs.push([tech('T1078', 0.6)]);
    }
    return { category, techniques: mergeTechniques(...techs), stage, ruleHints: hints };
  }

  const scanner = scannerMatch(event);
  if (scanner) {
    hint('R03');
    techs.push([tech('T1595.002', 0.8)]);
  }

  switch (event.event_type) {
    case 'connection.open':
    case 'ssh.client':
      category = 'recon';
      stage = 'recon';
      hint('R01');
      techs.push([tech('T1595', 0.7)]);
      break;
    case 'http.request': {
      category = 'recon';
      stage = 'recon';
      hint('R01');
      techs.push([tech('T1595', 0.7)]);
      const ex = exploitTypes(event);
      if (ex.length) {
        category = 'exploit';
        stage = 'initial_access';
        hint('R05');
        techs.push([tech('T1190', 0.7)]);
      }
      if (isExport2xx(event)) {
        category = 'collection';
        stage = 'exfiltration';
        hint('R11');
        hint('R18');
        techs.push([tech('T1005', 0.8), tech('T1041', 0.6)]);
      }
      break;
    }
    case 'auth.attempt': {
      category = 'credential';
      stage = 'initial_access';
      if (event.outcome === 'failure') {
        hint('R04');
        techs.push([tech('T1110.001', 0.9)]);
      } else if (event.outcome === 'success') {
        category = 'access';
        if (isCommonCredential(event, ctx)) {
          hint('R06');
          techs.push([tech('T1078.001', 0.9)]);
        } else {
          techs.push([tech('T1078', 0.6)]);
        }
      }
      if (exploitTypes(event).length) {
        hint('R05');
        techs.push([tech('T1190', 0.7)]);
      }
      break;
    }
    case 'command.exec':
    case 'db.command': {
      const f = factsOf(event);
      category = 'execution';
      stage = 'execution';
      hint('R07');
      techs.push([tech('T1059.004', 0.9)]);
      if (f.discovery.length) {
        category = 'discovery';
        stage = 'discovery';
        hint('R08');
        techs.push(f.discovery.map((d) => tech(d.technique, 0.8)));
      }
      if (f.transfer) {
        category = 'execution';
        stage = laterStage(stage, 'execution');
        hint('R09');
        techs.push([tech('T1105', 0.8)]);
      }
      if (f.persistence.length) {
        category = 'persistence';
        stage = 'execution';
        hint('R10');
        techs.push(f.persistence.map((id) => tech(id, 0.8)));
      }
      if (f.evasion) {
        category = 'defense_evasion';
        stage = 'execution';
        hint('R17');
        techs.push([tech('T1070.003', 0.9)]);
      }
      if (f.baitRead) {
        category = 'collection';
        stage = 'collection';
        hint('R11');
        hint('R18');
        techs.push([tech('T1005', 0.8), tech('T1041', 0.6)]);
        if (f.baitSecret) techs.push([tech('T1552.001', 0.8)]);
      }
      break;
    }
    case 'file.download':
    case 'file.upload':
      if (isBaitServed(event)) {
        category = 'collection';
        stage = 'exfiltration';
        hint('R11');
        hint('R18');
        techs.push([tech('T1005', 0.8), tech('T1041', 0.6)]);
      } else {
        category = 'execution';
        stage = 'execution';
        hint('R09');
        techs.push([tech('T1105', 0.8)]);
      }
      break;
    case 'honeytoken.read':
      category = 'collection';
      stage = 'collection';
      hint('R11');
      techs.push([tech('T1005', 0.8), tech('T1552.001', 0.8)]);
      break;
    case 'honeytoken.use':
      category = 'honeytoken';
      stage = 'exfiltration';
      hint('R16');
      techs.push([tech('T1078', 0.95), tech('T1552.001', 0.95)]);
      break;
    case 'proxy.attempt':
      category = 'tunnelling';
      stage = 'execution';
      hint('R19');
      techs.push([tech('T1090', 0.8)]);
      break;
    case 'connection.close':
    default:
      category = 'session';
      break;
  }

  return { category, techniques: mergeTechniques(...techs), stage, ruleHints: hints };
}
