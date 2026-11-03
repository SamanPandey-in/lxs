import fs from 'node:fs';
import path from 'node:path';
import { DecoyEvent } from '@lxs/schema';
import type { PlatformClient } from './platform.js';
import type { Counters, Logger } from './telemetry.js';

export interface ShipperOptions {
  client: Pick<PlatformClient, 'ingest'>;
  spoolDir: string;
  sensorId: () => string | undefined;
  counters: Counters;
  log?: Logger;
  batchSize?: number;
  /** In-memory ring: BREAKDOWN 5.12 says 10 000 events. Beyond it we spill to disk instead of dropping. */
  maxMemory?: number;
  /** Disk spool cap; oldest segments are dropped (and counted) beyond it. */
  maxSpoolBytes?: number;
  flushMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Called whenever nothing is in memory and nothing is in flight: safe point to persist tail offsets. */
  onIdle?: () => void;
  random?: () => number;
}

interface Segment {
  file: string;
  count: number;
  bytes: number;
}

const SEG_RE = /^spool-(\d{12})-(\d+)\.jsonl$/;

/**
 * Batches events, POSTs them with the Bearer key, and never loses them silently:
 * retry with exponential backoff + jitter (honouring Retry-After), spill to a disk spool when the platform
 * is unreachable, de-duplicate by event id (the ULID is also the platform's idempotency key).
 */
export class Shipper {
  private mem: DecoyEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private spool: Segment[] = [];
  private seq = 0;
  private running = false;
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private attempt = 0;
  private retryAt = 0;
  private inflight = false;
  private batchSize: number;
  private readonly o: Required<
    Pick<
      ShipperOptions,
      'batchSize' | 'maxMemory' | 'maxSpoolBytes' | 'flushMs' | 'backoffBaseMs' | 'backoffMaxMs'
    >
  >;
  private readonly random: () => number;

  constructor(private readonly opts: ShipperOptions) {
    this.o = {
      batchSize: opts.batchSize ?? 500,
      maxMemory: opts.maxMemory ?? 10_000,
      maxSpoolBytes: opts.maxSpoolBytes ?? 64 * 1024 * 1024,
      flushMs: opts.flushMs ?? 1000,
      backoffBaseMs: opts.backoffBaseMs ?? 500,
      backoffMaxMs: opts.backoffMaxMs ?? 60_000,
    };
    this.batchSize = this.o.batchSize;
    this.random = opts.random ?? Math.random;
    fs.mkdirSync(opts.spoolDir, { recursive: true });
    this.loadSpool();
  }

  /** Validate, de-duplicate, queue. Returns false if the event was rejected or already seen. */
  enqueue(ev: DecoyEvent): boolean {
    const parsed = DecoyEvent.safeParse(ev);
    if (!parsed.success) {
      this.opts.counters.inc('events_invalid');
      this.opts.log?.debug('dropping invalid event', {
        issues: parsed.error.issues.slice(0, 3).map((i) => i.message),
      });
      return false;
    }
    if (this.seen.has(ev.id)) {
      this.opts.counters.inc('events_deduped');
      return false;
    }
    this.remember(ev.id);
    this.mem.push(parsed.data);
    this.opts.counters.inc('events_queued');
    if (this.mem.length > this.o.maxMemory) this.spillMemory();
    if (this.mem.length >= this.batchSize) this.wake?.();
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopDone = this.loop();
  }

  /** Flush what we can within `timeoutMs`, then spill the rest to disk so a restart loses nothing. */
  async stop(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && (this.mem.length > 0 || this.inflight) && this.attempt === 0) {
      this.wake?.();
      await new Promise((r) => setTimeout(r, 50));
    }
    this.running = false;
    this.wake?.();
    await this.loopDone;
    if (this.mem.length > 0) this.spillMemory();
  }

  stats(): { memory: number; spoolSegments: number; spoolEvents: number; attempt: number } {
    return {
      memory: this.mem.length,
      spoolSegments: this.spool.length,
      spoolEvents: this.spool.reduce((a, s) => a + s.count, 0),
      attempt: this.attempt,
    };
  }

  /* ---------------------------------------------------------------- internals */

  private remember(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 50_000) {
      for (const old of this.seenOrder.splice(0, 10_000)) this.seen.delete(old);
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const wait = Math.max(0, this.retryAt - Date.now());
      if (wait > 0) {
        await this.sleep(Math.min(wait, 1000));
        if (this.mem.length > this.o.maxMemory) this.spillMemory();
        continue;
      }
      const did = await this.sendNext();
      if (!did) {
        this.opts.onIdle?.();
        await this.sleep(this.o.flushMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      this.wake = done;
      function done(): void {
        clearTimeout(t);
        resolve();
      }
    });
  }

  /** Oldest data first: spool segments, then memory. Returns false when there was nothing to send. */
  private async sendNext(): Promise<boolean> {
    const seg = this.spool[0];
    let events: DecoyEvent[];
    let fromSeg: Segment | null = null;
    if (seg) {
      events = this.readSegment(seg);
      fromSeg = seg;
      if (events.length === 0) {
        this.removeSegment(seg);
        return true;
      }
    } else if (this.mem.length > 0) {
      events = this.mem.slice(0, this.batchSize);
    } else {
      return false;
    }
    if (events.length > this.batchSize) events = events.slice(0, this.batchSize);

    this.inflight = true;
    const res = await this.opts.client.ingest({
      sensor_id: this.opts.sensorId(),
      sent_at: new Date().toISOString(),
      events,
    });
    this.inflight = false;

    if (res.status >= 200 && res.status < 300) {
      this.attempt = 0;
      this.retryAt = 0;
      this.batchSize = this.o.batchSize;
      this.opts.counters.inc('events_shipped', events.length);
      this.opts.counters.inc('events_duplicate_ack', res.body?.duplicates ?? 0);
      const rejected = Array.isArray(res.body?.rejected) ? res.body.rejected.length : 0;
      if (rejected > 0) {
        this.opts.counters.inc('events_rejected', rejected);
        this.opts.log?.warn('platform rejected some events', { rejected });
      }
      this.consumed(fromSeg, events.length);
      return true;
    }

    if (res.status === 413 && events.length > 1) {
      this.batchSize = Math.max(1, Math.floor(events.length / 2));
      return true; // retry immediately with a smaller batch
    }
    if ((res.status === 400 || res.status === 413 || res.status === 422) && events.length > 1) {
      this.batchSize = Math.max(1, Math.floor(events.length / 2)); // bisect to isolate a poison event
      return true;
    }
    if (res.status === 400 || res.status === 413 || res.status === 422) {
      this.opts.counters.inc('events_dropped_rejected');
      this.opts.log?.error('dropping event the platform will never accept', { status: res.status });
      this.consumed(fromSeg, events.length);
      return true;
    }

    // 0 (network), 401/403 (key problem), 429, 5xx: keep everything, back off.
    this.attempt++;
    const exp = Math.min(
      this.o.backoffMaxMs,
      this.o.backoffBaseMs * 2 ** Math.min(this.attempt - 1, 16),
    );
    const jittered = Math.round(exp * (0.8 + this.random() * 0.4));
    const delay = Math.min(this.o.backoffMaxMs * 5, Math.max(jittered, res.retryAfterMs ?? 0));
    this.retryAt = Date.now() + delay;
    this.opts.counters.inc('ship_retries');
    this.opts.log?.warn('ingest failed; will retry', {
      status: res.status,
      attempt: this.attempt,
      retry_in_ms: delay,
      ...(res.status === 401 || res.status === 403
        ? { hint: 'ingest key rejected: check .env.lxs' }
        : {}),
    });
    // Unreachable platform: move memory to disk so it survives a restart and memory stays bounded.
    if (!fromSeg && this.mem.length > 0) {
      this.spillMemory();
      this.opts.onIdle?.(); // everything is now on disk: offsets may advance
    }
    return true;
  }

  private consumed(seg: Segment | null, n: number): void {
    if (seg) this.removeSegment(seg);
    else this.mem.splice(0, n);
  }

  /* ---------------------------------------------------------------- disk spool */

  private loadSpool(): void {
    const segs: Segment[] = [];
    for (const name of fs.readdirSync(this.opts.spoolDir)) {
      const m = SEG_RE.exec(name);
      if (!m) continue;
      const file = path.join(this.opts.spoolDir, name);
      segs.push({ file, count: Number(m[2]), bytes: fs.statSync(file).size });
      this.seq = Math.max(this.seq, Number(m[1]));
    }
    this.spool = segs.sort((a, b) => a.file.localeCompare(b.file));
  }

  private spillMemory(): void {
    while (this.mem.length > 0) {
      const chunk = this.mem.splice(0, this.o.batchSize);
      this.seq++;
      const file = path.join(
        this.opts.spoolDir,
        `spool-${String(this.seq).padStart(12, '0')}-${chunk.length}.jsonl`,
      );
      const data = `${chunk.map((e) => JSON.stringify(e)).join('\n')}\n`;
      try {
        fs.writeFileSync(`${file}.tmp`, data);
        fs.renameSync(`${file}.tmp`, file);
        this.spool.push({ file, count: chunk.length, bytes: Buffer.byteLength(data) });
        this.opts.counters.inc('events_spooled', chunk.length);
      } catch (e) {
        this.opts.counters.inc('events_dropped_disk', chunk.length);
        this.opts.log?.error('spool write failed; events dropped', { error: (e as Error).message });
      }
    }
    this.enforceSpoolCap();
  }

  private enforceSpoolCap(): void {
    let total = this.spool.reduce((a, s) => a + s.bytes, 0);
    while (total > this.o.maxSpoolBytes && this.spool.length > 1) {
      const oldest = this.spool[0] as Segment;
      total -= oldest.bytes;
      this.opts.counters.inc('events_dropped_overflow', oldest.count);
      this.opts.log?.error('spool full; dropping oldest segment', { events: oldest.count });
      this.removeSegment(oldest);
    }
  }

  private readSegment(seg: Segment): DecoyEvent[] {
    try {
      const out: DecoyEvent[] = [];
      for (const line of fs.readFileSync(seg.file, 'utf8').split('\n')) {
        if (!line) continue;
        const p = DecoyEvent.safeParse(JSON.parse(line));
        if (p.success) out.push(p.data);
      }
      return out;
    } catch {
      return [];
    }
  }

  private removeSegment(seg: Segment): void {
    try {
      fs.rmSync(seg.file, { force: true });
    } catch {
      /* ignore */
    }
    this.spool = this.spool.filter((s) => s !== seg);
  }
}
