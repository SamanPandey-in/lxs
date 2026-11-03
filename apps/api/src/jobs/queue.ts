import PgBoss from 'pg-boss';
import { env } from '../env.js';

export const QUEUES = {
  processEvents: 'process-events',
  sweep: 'sweep-unprocessed',
  blocklistExpiry: 'blocklist-expiry',
  autoCloseNoise: 'auto-close-noise',
  retentionPurge: 'retention-purge',
  narrateIncident: 'narrate-incident',
  assessIncident: 'assess-incident',
} as const;

export interface NarrateIncidentJob {
  incidentId: string;
}

export interface AssessIncidentJob {
  incidentId: string;
}

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

type Narrator = (incidentId: string) => Promise<unknown>;
let inProcessNarrator: Narrator | null = null;
const narrateTimers = new Map<string, NodeJS.Timeout>();
type Assessor = (incidentId: string) => Promise<unknown>;
let inProcessAssessor: Assessor | null = null;
const assessTimers = new Map<string, NodeJS.Timeout>();
export const setInProcessAssessor = (fn: Assessor): void => {
  inProcessAssessor = fn;
};

export async function enqueueAssessIncident(incidentId: string): Promise<void> {
  const b = getBoss();
  if (b) {
    try {
      await b.send(QUEUES.assessIncident, { incidentId } satisfies AssessIncidentJob, {
        retryLimit: 2,
        retryBackoff: true,
        retryDelay: 2,
        singletonKey: incidentId,
      });
      return;
    } catch {
      /* fall through to in-process */
    }
  }
  if (inProcessAssessor && !assessTimers.has(incidentId)) {
    const fn = inProcessAssessor;
    assessTimers.set(
      incidentId,
      setTimeout(() => {
        assessTimers.delete(incidentId);
        void fn(incidentId).catch(() => {});
      }, 0),
    );
  }
}
export const setInProcessNarrator = (fn: Narrator): void => {
  inProcessNarrator = fn;
};

/**
 * Ask for an incident to be narrated once the burst settles. A chain of events costs one
 * provider call per window, not one per batch: later batches in a window are dropped, and
 * the job still sees them because it reads the incident when it runs, after the window ends.
 */
export async function enqueueNarrate(incidentId: string): Promise<void> {
  const seconds = env.LLM_DEBOUNCE_SECONDS;
  const b = getBoss();
  if (b) {
    try {
      await b.send(
        QUEUES.narrateIncident,
        { incidentId } satisfies NarrateIncidentJob,
        seconds > 0
          ? { singletonKey: incidentId, singletonSeconds: seconds, startAfter: seconds }
          : {},
      );
      return;
    } catch {
      /* fall through to in-process */
    }
  }
  if (inProcessNarrator && !narrateTimers.has(incidentId)) {
    const fn = inProcessNarrator;
    narrateTimers.set(
      incidentId,
      setTimeout(() => {
        narrateTimers.delete(incidentId);
        void fn(incidentId).catch(() => {});
      }, seconds * 1000),
    );
  }
}
