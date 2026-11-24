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
  notifyIncident: 'notify-incident',
  weeklyDigest: 'weekly-digest',
  exportProject: 'export-project',
  autoBlock: 'auto-block',
} as const;

export interface NotifyIncidentJob {
  incidentId: string;
}

export interface NarrateIncidentJob {
  incidentId: string;
}

export interface AssessIncidentJob {
  incidentId: string;
}

export interface ProcessEventsJob {
  projectId?: string;
  eventIds?: string[];
  /**
   * Coalesced form: process every pending event of one source in one project. Set together
   * with `projectId` by `enqueueProcessSources`; the job reads what is pending when it runs,
   * so events that arrived after it was queued are picked up without a job of their own.
   */
  srcIp?: string;
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

/**
 * Coalescing window for per-source processing (G5). pg-boss debounce semantics: the first
 * send in a window runs at once, a second send in the same window is moved to the start of
 * the next window, and further sends in that window are dropped because the queued job has
 * not started yet and will read their events anyway. So a burst of N ingest calls costs
 * about (burst seconds / window) + 1 jobs instead of N.
 */
export const PROCESS_COALESCE_SECONDS = 1;
/** Above this many distinct sources in one batch, fall back to one id-scoped job (a sweep-sized scan). */
export const MAX_SOURCE_JOBS_PER_BATCH = 25;

export const processSourceKey = (projectId: string, srcIp: string): string =>
  `${projectId}|ip:${srcIp}`;

const sourceTimers = new Map<string, NodeJS.Timeout>();

/**
 * Enqueue coalesced processing for the sources of a freshly stored batch: one pg-boss
 * singleton per (project, source) with a short debounce. Batches spanning many sources keep
 * the old id-scoped job so one scanner-heavy batch does not fan out into hundreds of sends.
 */
export async function enqueueProcessSources(
  projectId: string,
  inserted: { id: string; srcIp: string }[],
): Promise<void> {
  if (inserted.length === 0) return;
  const sources = [...new Set(inserted.map((r) => r.srcIp))];
  if (sources.length > MAX_SOURCE_JOBS_PER_BATCH) {
    await enqueueProcessEvents({ projectId, eventIds: inserted.map((r) => r.id) });
    return;
  }
  for (const srcIp of sources) await enqueueProcessSource(projectId, srcIp);
}

async function enqueueProcessSource(projectId: string, srcIp: string): Promise<void> {
  const key = processSourceKey(projectId, srcIp);
  const job: ProcessEventsJob = { projectId, srcIp };
  const b = getBoss();
  if (b) {
    try {
      // A null id means "coalesced into the job already queued for the next window".
      await b.send(QUEUES.processEvents, job as object, {
        singletonKey: key,
        singletonSeconds: PROCESS_COALESCE_SECONDS,
        singletonNextSlot: true,
        retryLimit: 5,
        retryBackoff: true,
        retryDelay: 2,
      });
      return;
    } catch {
      /* fall through to in-process */
    }
  }
  // In-process: one pending timer per source. The key is cleared when the timer fires, so
  // events arriving while that run is in flight schedule the next one (the advisory lock in
  // processGroup serialises the two).
  if (inProcess && !sourceTimers.has(key)) {
    const fn = inProcess;
    sourceTimers.set(
      key,
      setTimeout(() => {
        sourceTimers.delete(key);
        void fn(job).catch(() => {});
      }, PROCESS_COALESCE_SECONDS * 250),
    );
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

type Notifier = (incidentId: string) => Promise<unknown>;
let inProcessNotifier: Notifier | null = null;
export const setInProcessNotifier = (fn: Notifier): void => {
  inProcessNotifier = fn;
};

/** Short settle so a burst that opens several incidents for one attacker pages once. */
export const NOTIFY_SETTLE_SECONDS = 3;

/**
 * Ask for an incident's alert channels to be evaluated. The job is idempotent (dedupe lives
 * in notification_deliveries), so enqueueing on every create or severity change is safe.
 * Retries back off exponentially: 5 s, 10 s, 20 s, 40 s.
 */
export async function enqueueNotifyIncident(
  incidentId: string,
  delaySeconds = NOTIFY_SETTLE_SECONDS,
): Promise<void> {
  const b = getBoss();
  if (b) {
    try {
      await b.send(QUEUES.notifyIncident, { incidentId } satisfies NotifyIncidentJob, {
        retryLimit: 4,
        retryDelay: 5,
        retryBackoff: true,
        startAfter: Math.max(0, Math.ceil(delaySeconds)),
        expireInSeconds: 120,
      });
      return;
    } catch {
      /* fall through to in-process */
    }
  }
  if (inProcessNotifier) {
    const fn = inProcessNotifier;
    const run = (attempt: number) =>
      void fn(incidentId).catch(() => {
        if (attempt < 4) setTimeout(() => run(attempt + 1), 5000 * 2 ** attempt).unref?.();
      });
    setTimeout(() => run(0), Math.max(0, delaySeconds) * 1000).unref?.();
  }
}

/** The weekly digest cron; `off` (any case) disables it. */
export const digestCron = (expr = env.DIGEST_CRON): string | null =>
  expr.trim().toLowerCase() === 'off' ? null : expr.trim();
export interface ExportProjectJob {
  exportId: string;
}

type Exporter = (exportId: string) => Promise<unknown>;
let inProcessExporter: Exporter | null = null;
export const setInProcessExporter = (fn: Exporter): void => {
  inProcessExporter = fn;
};

/**
 * Queue a project export (worker/export-project.ts). The job is idempotent: it only picks
 * up an export row still in `pending`, so a retry after a crash mid-run is marked failed by
 * maintenance instead of writing two bundles. Without pg-boss it runs in-process.
 */
export async function enqueueExportProject(exportId: string): Promise<void> {
  const b = getBoss();
  if (b) {
    try {
      await b.send(QUEUES.exportProject, { exportId } satisfies ExportProjectJob, {
        retryLimit: 0,
        singletonKey: exportId,
        expireInSeconds: 3600,
      });
      return;
    } catch {
      /* fall through to in-process */
    }
  }
  if (inProcessExporter) {
    const fn = inProcessExporter;
    setImmediate(() => void fn(exportId).catch(() => {}));
  }
}

export interface AutoBlockJob {
  incidentId: string;
}

type AutoBlocker = (incidentId: string) => Promise<unknown>;
let inProcessAutoBlocker: AutoBlocker | null = null;
export const setInProcessAutoBlocker = (fn: AutoBlocker): void => {
  inProcessAutoBlocker = fn;
};

/**
 * Evaluate the project's auto-block policy for an incident. Cheap and idempotent (the job
 * re-reads everything and refuses to act twice per incident), so it is enqueued after every
 * processed group; a 2 s singleton window collapses bursts.
 */
export async function enqueueAutoBlock(incidentId: string): Promise<void> {
  const b = getBoss();
  if (b) {
    try {
      await b.send(QUEUES.autoBlock, { incidentId } satisfies AutoBlockJob, {
        singletonKey: incidentId,
        singletonSeconds: 2,
        singletonNextSlot: true,
        retryLimit: 3,
        retryBackoff: true,
        retryDelay: 2,
      });
      return;
    } catch {
      /* fall through to in-process */
    }
  }
  if (inProcessAutoBlocker) {
    const fn = inProcessAutoBlocker;
    setImmediate(() => void fn(incidentId).catch(() => {}));
  }
}
