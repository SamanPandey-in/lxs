import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { monotonicFactory } from 'ulid';
import { sql } from '../db/client.js';
import { badRequest } from '../lib/errors.js';
import { STREAM_CHANNEL } from '../lib/notify.js';
import { projectAccess, requireSession } from './auth-session.js';

const nextId = monotonicFactory();
const RING_SIZE = 1000;
const REPLAY_TYPES = new Set(['incident.new', 'incident.updated']);

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
    for (const res of set) res.write(text);
  }

  serialize(f: Frame): string {
    return `id: ${f.id}\nevent: ${f.event}\ndata: ${f.data}\n\n`;
  }

  add(projectId: string, res: ServerResponse, lastEventId?: string): void {
    let set = this.clients.get(projectId);
    if (!set) this.clients.set(projectId, (set = new Set()));
    set.add(res);
    if (lastEventId) {
      for (const f of this.ring.get(projectId) ?? [])
        if (f.id > lastEventId) res.write(this.serialize(f));
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
}

export const hub = new StreamHub();

/** GET /v1/stream?project=:pid — Server-Sent Events, session auth, 15 s keep-alive. */
export async function registerStreamRoute(app: FastifyInstance): Promise<void> {
  app.get('/v1/stream', { preHandler: requireSession }, async (req, reply) => {
    const { project } = req.query as { project?: string };
    if (!project) throw badRequest('Query parameter "project" is required');
    await projectAccess(req, project, 'viewer');

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
    hub.add(project, res, lastEventId);

    const timer = setInterval(() => {
      res.write(
        `: keep-alive\n\nevent: heartbeat\ndata: ${JSON.stringify({ t: new Date().toISOString() })}\n\n`,
      );
    }, 15_000);
    const cleanup = () => {
      clearInterval(timer);
      hub.remove(project, res);
    };
    req.raw.on('close', cleanup);
    res.on('error', cleanup);
  });
}
