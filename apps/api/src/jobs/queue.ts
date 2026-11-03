import PgBoss from 'pg-boss';
import { env } from '../env.js';

export const QUEUES = {
  processEvents: 'process-events',
  sweep: 'sweep-unprocessed',
  blocklistExpiry: 'blocklist-expiry',
  autoCloseNoise: 'auto-close-noise',
  retentionPurge: 'retention-purge',
} as const;

export interface ProcessEventsJob {
  projectId?: string;
  eventIds?: string[];
}

let boss: PgBoss | null = null;
let ready = false;

/** Start pg-boss (owns the `pgboss` schema). Returns null if it cannot start; callers fall back to in-process work. */
export async function startBoss(log: {
  warn: (o: unknown, m?: string) => void;
  info: (m: string) => void;
}): Promise<PgBoss | null> {
  if (boss) return boss;
  try {
    const b = new PgBoss({ connectionString: env.DATABASE_URL, schema: 'pgboss', max: 4 });
    b.on('error', (err) => log.warn({ err }, 'pg-boss error'));
    await b.start();
    for (const q of Object.values(QUEUES)) {
      try {
        await b.createQueue(q);
      } catch {
        /* queue already exists */
      }
    }
    boss = b;
    ready = true;
    log.info('pg-boss started');
    return b;
  } catch (err) {
    log.warn({ err }, 'pg-boss failed to start; jobs will run in-process');
    boss = null;
    ready = false;
    return null;
  }
}

export const getBoss = (): PgBoss | null => (ready ? boss : null);

export async function stopBoss(): Promise<void> {
  if (boss) await boss.stop({ graceful: true, timeout: 5000 }).catch(() => {});
  boss = null;
  ready = false;
}

type Processor = (job: ProcessEventsJob) => Promise<unknown>;
let inProcess: Processor | null = null;
export const setInProcessProcessor = (fn: Processor): void => {
  inProcess = fn;
};

/** Enqueue a process-events job; if the queue is unavailable, run it in-process so ingest never loses work. */
export async function enqueueProcessEvents(job: ProcessEventsJob): Promise<void> {
  const b = getBoss();
  if (b) {
    try {
      await b.send(QUEUES.processEvents, job as object, {
        retryLimit: 5,
        retryBackoff: true,
        retryDelay: 2,
      });
      return;
    } catch {
      /* fall through to in-process */
    }
  }
  if (inProcess) {
    const fn = inProcess;
    setImmediate(() => void fn(job).catch(() => {}));
  }
}
