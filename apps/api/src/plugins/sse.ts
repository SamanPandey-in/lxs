import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { monotonicFactory } from 'ulid';
import { sql } from '../db/client.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { STREAM_CHANNEL } from '../lib/notify.js';
import { projectAccess, requireSession } from './auth-session.js';

const nextId = monotonicFactory();
const RING_SIZE = 1000;
const REPLAY_TYPES = new Set(['incident.new', 'incident.updated']);

/**
 * Ceilings on live stream connections. /v1/stream used to be uncapped: the
 * dashboard reconnects with backoff and a presenter reloads repeatedly during
 * setup, so dead responses accumulated and each kept a 15 s heartbeat writing
 * forever. Generous enough that no real audience hits them.
 */
export const MAX_CLIENTS_PER_PROJECT = 50;
export const MAX_CLIENTS_TOTAL = 500;

interface Frame {
  id: string;
  event: string;
  data: string;
}

class StreamHub {
  private clients = new Map<string, Set<ServerResponse>>();
  private ring = new Map<string, Frame[]>();
  private started = false;

  async start(log: { warn: (o: unknown, m?: string) => void }): Promise<void> {
    if (this.started) return;
    this.started = true;
    await sql.listen(
      STREAM_CHANNEL,
      (payload) => this.dispatch(payload),
      () => {
        log.warn({}, 'stream listener (re)connected');
      },
    );
  }

  private dispatch(payload: string): void {
    let msg: { p?: string; t?: string; d?: unknown };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (!msg.p || !msg.t) return;
    const frame: Frame = { id: nextId(), event: msg.t, data: JSON.stringify(msg.d ?? {}) };
    if (REPLAY_TYPES.has(msg.t)) {
      const r = this.ring.get(msg.p) ?? [];
      r.push(frame);
      if (r.length > RING_SIZE) r.shift();
      this.ring.set(msg.p, r);
    }
    const set = this.clients.get(msg.p);
    if (!set) return;
    const text = this.serialize(frame);
    // Copy: write() drops dead clients, which mutates the set we are walking.
    for (const res of [...set]) this.write(msg.p, res, text);
  }

  serialize(f: Frame): string {
    return `id: ${f.id}\nevent: ${f.event}\ndata: ${f.data}\n\n`;
  }

  /**
   * Write one chunk, dropping the client if the socket has gone. Returns false
   * when nothing was written, so callers can stop their own timers.
   */
  write(projectId: string, res: ServerResponse, text: string): boolean {
    if (res.destroyed || res.writableEnded) {
      this.remove(projectId, res);
      return false;
    }
    try {
      res.write(text);
      return true;
    } catch {
      this.remove(projectId, res);
      return false;
    }
  }

  add(projectId: string, res: ServerResponse, lastEventId?: string): void {
    let set = this.clients.get(projectId);
    if (!set) this.clients.set(projectId, (set = new Set()));
    set.add(res);
    if (lastEventId) {
      for (const f of this.ring.get(projectId) ?? [])
        if (f.id > lastEventId) this.write(projectId, res, this.serialize(f));
    }
  }

  remove(projectId: string, res: ServerResponse): void {
    const set = this.clients.get(projectId);
    set?.delete(res);
    if (set && set.size === 0) this.clients.delete(projectId);
  }

  get connections(): number {
    let n = 0;
    for (const s of this.clients.values()) n += s.size;
    return n;
  }

  /** Live connections for one project, used to enforce the per-project ceiling. */
  countFor(projectId: string): number {
    return this.clients.get(projectId)?.size ?? 0;
  }

  /** Drop clients whose socket has already gone. Returns how many were reaped. */
  prune(): number {
    let reaped = 0;
    for (const [projectId, set] of [...this.clients]) {
      for (const res of [...set]) {
        if (res.destroyed || res.writableEnded) {
          this.remove(projectId, res);
          reaped += 1;
        }
      }
    }
    return reaped;
  }
}

export const hub = new StreamHub();

/** GET /v1/stream?project=:pid — Server-Sent Events, session auth, 15 s keep-alive. */
export async function registerStreamRoute(app: FastifyInstance): Promise<void> {
  app.get('/v1/stream', { preHandler: requireSession }, async (req, reply) => {
    const { project } = req.query as { project?: string };
    if (!project) throw badRequest('Query parameter "project" is required');
    const { project: p } = await projectAccess(req, project, 'viewer');

    // Reap anything already dead before judging the ceilings, so a run of stale
    // connections cannot lock out a legitimate viewer.
    hub.prune();
    if (hub.countFor(p.id) >= MAX_CLIENTS_PER_PROJECT || hub.connections >= MAX_CLIENTS_TOTAL)
      throw new HttpError(
        429,
        'too_many_streams',
        'Too many live stream connections for this project; close an open dashboard and retry',
      );

    const lastEventId = (req.headers['last-event-id'] as string | undefined) ?? undefined;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...reply.getHeaders(), // keeps CORS headers added by @fastify/cors
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    } as Record<string, string>);
    res.write(`retry: 3000\n: connected\n\n`);
    hub.add(p.id, res, lastEventId);

    const cleanup = () => {
      clearInterval(timer);
      hub.remove(p.id, res);
    };
    // The heartbeat is also the liveness check: if the socket has gone without
    // firing any of the events below, the failed write tears the client down
    // here rather than leaving this timer running for the life of the process.
    const timer = setInterval(() => {
      const beat = `: keep-alive\n\nevent: heartbeat\ndata: ${JSON.stringify({ t: new Date().toISOString() })}\n\n`;
      if (!hub.write(p.id, res, beat)) cleanup();
    }, 15_000);
    req.raw.on('close', cleanup);
    req.raw.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  });
}
