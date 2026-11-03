import fs from 'node:fs';
import path from 'node:path';

/**
 * ds-web log line (BREAKDOWN 7.5). One JSON object per line, appended to the shared log volume.
 * Attacker-controlled strings only ever appear here as JSON string values (JSON.stringify escapes them,
 * so a payload cannot forge or split lines).
 */
export interface LogLine {
  ts: string;
  decoy_id: string;
  kind: 'request' | 'login' | 'bait' | 'export' | 'start' | 'dropped';
  ip: string;
  method: string;
  path: string;
  query?: string;
  ua?: string;
  username?: string;
  password?: string;
  accepted?: boolean;
  req_id: string;
  status?: number;
  file?: string;
  honeytoken_id?: string;
  honeytoken_ids?: string[];
  body?: string;
  bytes?: number;
  count?: number;
}

export interface LoggerOptions {
  dir: string;
  file?: string;
  maxBytes?: number;
  keep?: number;
  /** Token bucket: sustained lines per second and burst. A flood cannot fill the volume. */
  perSecond?: number;
  burst?: number;
  now?: () => number;
}

const MAX_LINE = 12 * 1024;

export class JsonlLogger {
  readonly file: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly perSecond: number;
  private readonly burst: number;
  private readonly now: () => number;
  private size = 0;
  private tokens: number;
  private lastRefill: number;
  private dropped = 0;

  constructor(opts: LoggerOptions) {
    this.file = path.join(opts.dir, opts.file ?? 'ds-web.jsonl');
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.keep = opts.keep ?? 3;
    this.perSecond = opts.perSecond ?? 100;
    this.burst = opts.burst ?? 300;
    this.now = opts.now ?? Date.now;
    this.tokens = this.burst;
    this.lastRefill = this.now();
    fs.mkdirSync(opts.dir, { recursive: true });
    try {
      this.size = fs.statSync(this.file).size;
    } catch {
      this.size = 0;
    }
  }

  write(line: LogLine): void {
    const t = this.now();
    this.tokens = Math.min(
      this.burst,
      this.tokens + ((t - this.lastRefill) / 1000) * this.perSecond,
    );
    this.lastRefill = t;
    if (this.tokens < 1) {
      this.dropped++;
      return;
    }
    this.tokens -= 1;
    if (this.dropped > 0) {
      const count = this.dropped;
      this.dropped = 0;
      this.append({
        ts: new Date(t).toISOString(),
        decoy_id: '-',
        kind: 'dropped',
        ip: '0.0.0.0',
        method: '-',
        path: '-',
        req_id: '-',
        count,
      });
    }
    this.append(line);
  }

  private append(line: LogLine): void {
    let s = JSON.stringify(line);
    if (s.length > MAX_LINE) {
      // Drop the largest free-form fields rather than emitting a line the agent would reject.
      s = JSON.stringify({
        ...line,
        body: undefined,
        query: line.query?.slice(0, 256),
        ua: line.ua?.slice(0, 128),
      });
    }
    s += '\n';
    try {
      if (this.size + s.length > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, s, { mode: 0o644 });
      this.size += s.length;
    } catch {
      this.dropped++; // never let a full or read-only volume take the decoy down
    }
  }

  private rotate(): void {
    for (let i = this.keep - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      } catch {
        /* missing */
      }
    }
    try {
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      /* missing */
    }
    try {
      fs.rmSync(`${this.file}.${this.keep + 1}`, { force: true });
    } catch {
      /* ignore */
    }
    this.size = 0;
  }
}
