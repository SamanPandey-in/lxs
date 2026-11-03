import fs from 'node:fs';
import path from 'node:path';
import type { Counters, Logger } from './telemetry.js';

export interface TailSource {
  kind: 'web' | 'ssh';
  dir: string;
  /** Only the live file is followed; rotated copies are drained through the already-open handle. */
  match: RegExp;
  decoyId: string;
}

export interface TailLine {
  source: TailSource;
  file: string;
  offset: number;
  text: string;
}

export interface TailOptions {
  sources: TailSource[];
  statePath: string;
  onLine: (line: TailLine) => void;
  pollMs?: number;
  /** Lines longer than this are dropped and counted (BREAKDOWN 7.11). */
  maxLine?: number;
  counters?: Counters;
  log?: Logger;
}

interface FileState {
  path: string;
  source: TailSource;
  fh: fs.promises.FileHandle | null;
  ino: string;
  /** Next byte to read. */
  pos: number;
  /** Offset after the last complete line: the only offset that is safe to persist. */
  consumed: number;
  carry: Buffer;
  /** Inside an over-long line: discard until the next newline. */
  skipping: boolean;
}

type Persisted = Record<string, { ino: string; offset: number }>;

const CHUNK = 256 * 1024;

/**
 * Follows append-only JSONL files by polling stat() (portable, unaffected by Docker volume event quirks).
 * Resumes from persisted offsets, handles rotation (inode change) and truncation, and never emits a partial line.
 */
export class TailManager {
  private readonly files = new Map<string, FileState>();
  private persisted: Persisted = {};
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private polling = false;
  private readonly pollMs: number;
  private readonly maxLine: number;

  constructor(private readonly opts: TailOptions) {
    this.pollMs = opts.pollMs ?? 500;
    this.maxLine = opts.maxLine ?? 64 * 1024;
    try {
      this.persisted = JSON.parse(fs.readFileSync(opts.statePath, 'utf8')) as Persisted;
    } catch {
      this.persisted = {};
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      if (!this.polling) {
        this.polling = true;
        try {
          await this.pollOnce();
        } catch (e) {
          this.opts.log?.warn('tail poll failed', { error: (e as Error).message });
        } finally {
          this.polling = false;
        }
      }
      if (this.running) this.timer = setTimeout(tick, this.pollMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    while (this.polling) await new Promise((r) => setTimeout(r, 10));
    this.commit();
    for (const f of this.files.values()) await f.fh?.close().catch(() => undefined);
    this.files.clear();
  }

  /** Persist consumed offsets. Call only when everything read so far is durably handed off (shipped or spooled). */
  commit(): void {
    const out: Persisted = { ...this.persisted };
    for (const f of this.files.values()) out[f.path] = { ino: f.ino, offset: f.consumed };
    this.persisted = out;
    try {
      fs.mkdirSync(path.dirname(this.opts.statePath), { recursive: true });
      const tmp = `${this.opts.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, this.opts.statePath);
    } catch (e) {
      this.opts.log?.warn('could not persist tail offsets', { error: (e as Error).message });
    }
  }

  /** Bytes of the live files not yet consumed (for heartbeat stats). */
  lagBytes(): number {
    let total = 0;
    for (const f of this.files.values()) {
      try {
        total += Math.max(0, fs.statSync(f.path).size - f.consumed);
      } catch {
        /* gone */
      }
    }
    return total;
  }

  /** One discovery + read pass. Exposed for tests. */
  async pollOnce(): Promise<void> {
    for (const src of this.opts.sources) {
      let names: string[] = [];
      try {
        names = await fs.promises.readdir(src.dir);
      } catch {
        continue; // volume not mounted yet / decoy not started
      }
      for (const name of names.sort()) {
        if (!src.match.test(name)) continue;
        const p = path.join(src.dir, name);
        if (!this.files.has(p)) {
          this.files.set(p, {
            path: p,
            source: src,
            fh: null,
            ino: '',
            pos: 0,
            consumed: 0,
            carry: Buffer.alloc(0),
            skipping: false,
          });
        }
      }
    }
    for (const f of this.files.values()) await this.readFile(f);
  }

  private async open(f: FileState): Promise<boolean> {
    try {
      f.fh = await fs.promises.open(f.path, 'r');
      const st = await f.fh.stat();
      f.ino = String(st.ino);
      const prev = this.persisted[f.path];
      const resume = prev && prev.ino === f.ino && prev.offset <= st.size ? prev.offset : 0;
      f.pos = resume;
      f.consumed = resume;
      f.carry = Buffer.alloc(0);
      f.skipping = false;
      return true;
    } catch {
      f.fh = null;
      return false;
    }
  }

  private async readFile(f: FileState): Promise<void> {
    for (let rounds = 0; rounds < 8; rounds++) {
      if (!f.fh && !(await this.open(f))) return;
      const fh = f.fh as fs.promises.FileHandle;
      // Drain the open handle (this is what picks up the tail of a rotated file).
      const buf = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, CHUNK, f.pos);
        if (bytesRead === 0) break;
        f.pos += bytesRead;
        this.consume(f, buf.subarray(0, bytesRead));
      }
      // Truncated in place?
      const handleStat = await fh.stat().catch(() => null);
      if (handleStat && handleStat.size < f.pos) {
        this.opts.log?.info('log truncated, restarting from 0', { file: f.path });
        f.pos = 0;
        f.consumed = 0;
        f.carry = Buffer.alloc(0);
        continue;
      }
      // Rotated (path now points at a different inode)?
      const pathStat = await fs.promises.stat(f.path).catch(() => null);
      if (pathStat && String(pathStat.ino) !== f.ino) {
        await fh.close().catch(() => undefined);
        f.fh = null;
        delete this.persisted[f.path];
        this.opts.counters?.inc('log_rotations');
        continue; // reopen the new file immediately
      }
      return;
    }
  }

  private consume(f: FileState, chunk: Buffer): void {
    const data = f.carry.length > 0 ? Buffer.concat([f.carry, chunk]) : chunk;
    const base = f.pos - data.length; // file offset of data[0]
    let start = 0;
    for (;;) {
      const nl = data.indexOf(10, start);
      if (nl < 0) break;
      if (f.skipping) {
        f.skipping = false; // end of the over-long line
      } else {
        const len = nl - start;
        if (len > this.maxLine) {
          this.opts.counters?.inc('lines_dropped_oversize');
        } else if (len > 0) {
          const text = data.toString('utf8', start, data[nl - 1] === 13 ? nl - 1 : nl);
          this.opts.counters?.inc('lines_read');
          try {
            this.opts.onLine({ source: f.source, file: f.path, offset: base + start, text });
          } catch (e) {
            this.opts.log?.warn('line handler threw', { error: (e as Error).message });
          }
        }
      }
      start = nl + 1;
      f.consumed = base + start;
    }
    const rest = data.subarray(start);
    if (rest.length > this.maxLine) {
      // Over-long unterminated line: drop it and everything up to its newline.
      if (!f.skipping) this.opts.counters?.inc('lines_dropped_oversize');
      f.skipping = true;
      f.carry = Buffer.alloc(0);
    } else {
      f.carry = f.skipping ? Buffer.alloc(0) : Buffer.from(rest);
    }
  }
}
