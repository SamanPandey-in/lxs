/**
 * Agent self-telemetry: counters that ride along in heartbeats (so drops show up on the System page)
 * and a tiny JSON logger to stderr with credential redaction.
 */
export class Counters {
  private readonly m = new Map<string, number>();

  inc(name: string, by = 1): void {
    this.m.set(name, (this.m.get(name) ?? 0) + by);
  }

  set(name: string, v: number): void {
    this.m.set(name, v);
  }

  get(name: string): number {
    return this.m.get(name) ?? 0;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.m);
  }
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let secrets: string[] = [];

/** Anything registered here is replaced by [redacted] in every log line. */
export function registerSecret(s: string): void {
  if (s.length >= 8) secrets.push(s);
}

export function redact(text: string): string {
  let out = text.replace(/ds_(live|test)_[A-Za-z0-9]+/g, 'ds_$1_[redacted]');
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out;
}

export function resetSecrets(): void {
  secrets = [];
}

export interface Logger {
  debug(msg: string, f?: Record<string, unknown>): void;
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
  error(msg: string, f?: Record<string, unknown>): void;
}

export function createLogger(opts: { level?: Level; write?: (line: string) => void } = {}): Logger {
  const min = ORDER[opts.level ?? (process.env.LXS_LOG_LEVEL as Level | undefined) ?? 'info'] ?? 20;
  const write = opts.write ?? ((l: string) => process.stderr.write(`${l}\n`));
  const emit = (level: Level, msg: string, f?: Record<string, unknown>): void => {
    if (ORDER[level] < min) return;
    write(redact(JSON.stringify({ t: new Date().toISOString(), level, msg, ...f })));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
