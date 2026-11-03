import { gzipSync } from 'node:zlib';
import { AGENT_VERSION } from './config.js';
import { redact } from './telemetry.js';

export interface RegisterResponse {
  sensor_id: string;
  password_salt: string;
  heartbeat_seconds?: number;
  policy_poll_seconds?: number;
  max_batch?: number;
  project?: { id: string; name: string };
}

export interface IngestResult {
  /** 0 = network error / timeout. */
  status: number;
  retryAfterMs?: number;
  body?: { accepted?: number; duplicates?: number; rejected?: unknown[] };
  error?: string;
}

export interface PolicyResult {
  status: number; // 200, 304, or 0 on failure
  etag?: string;
  body?: unknown;
  error?: string;
}

export type FetchLike = typeof fetch;

/**
 * Thin HTTPS client for the four machine endpoints. The Bearer key is attached here and nowhere else;
 * errors are redacted before they leave this module.
 */
export class PlatformClient {
  constructor(
    private readonly endpoint: string,
    private readonly key: string,
    private readonly sdkVersion: string = AGENT_VERSION,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.key}`,
      'user-agent': `lxs-agent/${AGENT_VERSION} (sdk ${this.sdkVersion})`,
      accept: 'application/json',
      ...extra,
    };
  }

  private async call(
    method: string,
    path: string,
    opts: { body?: string | Buffer; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; headers: Headers; text: string }> {
    const res = await this.fetchImpl(`${this.endpoint}${path}`, {
      method,
      headers: this.headers(opts.headers),
      body: opts.body as never,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  async register(manifest: unknown): Promise<RegisterResponse> {
    const r = await this.call('POST', '/v1/agent/register', {
      body: JSON.stringify(manifest),
      headers: { 'content-type': 'application/json' },
    });
    if (r.status < 200 || r.status >= 300)
      throw new Error(`register failed: HTTP ${r.status} ${redact(r.text.slice(0, 200))}`);
    const j = JSON.parse(r.text) as RegisterResponse;
    if (!j.sensor_id) throw new Error('register response had no sensor_id');
    return j;
  }

  async heartbeat(body: unknown): Promise<number> {
    try {
      const r = await this.call('POST', '/v1/agent/heartbeat', {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
      return r.status;
    } catch {
      return 0;
    }
  }

  async policy(etag?: string): Promise<PolicyResult> {
    try {
      const r = await this.call('GET', '/v1/agent/policy', {
        headers: etag ? { 'if-none-match': etag } : {},
      });
      if (r.status === 304) return { status: 304, etag };
      if (r.status !== 200) return { status: r.status, error: `HTTP ${r.status}` };
      return { status: 200, etag: r.headers.get('etag') ?? undefined, body: JSON.parse(r.text) };
    } catch (e) {
      return { status: 0, error: redact((e as Error).message) };
    }
  }

  async ingest(batch: {
    sensor_id?: string;
    sent_at: string;
    events: unknown[];
  }): Promise<IngestResult> {
    try {
      const raw = Buffer.from(JSON.stringify(batch));
      const body = raw.length > 1024 ? gzipSync(raw) : raw;
      const r = await this.call('POST', '/v1/ingest', {
        body,
        headers: {
          'content-type': 'application/json',
          ...(body !== raw ? { 'content-encoding': 'gzip' } : {}),
        },
      });
      const ra = Number(r.headers.get('retry-after'));
      let parsed: IngestResult['body'];
      try {
        parsed = JSON.parse(r.text) as IngestResult['body'];
      } catch {
        parsed = undefined;
      }
      return {
        status: r.status,
        retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 300) * 1000 : undefined,
        body: parsed,
      };
    } catch (e) {
      return { status: 0, error: redact((e as Error).message) };
    }
  }

  async selftestReport(body: unknown): Promise<number> {
    try {
      const r = await this.call('POST', '/v1/agent/selftest-report', {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
      return r.status;
    } catch {
      return 0;
    }
  }
}
