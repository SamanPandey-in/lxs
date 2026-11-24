import type { FastifyBaseLogger } from 'fastify';
import {
  type AssessIncidentJob,
  digestCron,
  type ExportProjectJob,
  getBoss,
  type NarrateIncidentJob,
  type NotifyIncidentJob,
  type ProcessEventsJob,
  QUEUES,
  setInProcessAssessor,
  setInProcessExporter,
  setInProcessNarrator,
  setInProcessNotifier,
  setInProcessProcessor,
} from '../jobs/queue.js';
import { timeJob } from '../plugins/metrics.js';
import { assessIncident } from './assess-incident.js';
import { loadDetection } from './detection.js';
import { exportProject } from './export-project.js';
import {
  autoCloseNoise,
  blocklistExpiry,
  dailyDataMaintenance,
  exportCleanup,
  sensorStaleness,
} from './maintenance.js';
import { llmConfig, narrateIncident } from './narrator.js';
import { notifyIncident } from './notify-incident.js';
import { processEvents } from './process-events.js';
import { weeklyDigest } from './weekly-digest.js';

const timers: NodeJS.Timeout[] = [];

/** Register queue handlers + schedules (ROLE=worker|all). Falls back to timers when pg-boss is unavailable. */
export async function startWorker(log: FastifyBaseLogger): Promise<void> {
  const det = await loadDetection();
  void det;
  setInProcessProcessor(processEvents);
  setInProcessNarrator(narrateIncident);
  setInProcessAssessor(assessIncident);
  setInProcessNotifier(notifyIncident);
  setInProcessExporter((id) => exportProject(id));
  log.info(
    llmConfig
      ? `worker: LLM narrator on (${llmConfig.provider}, ${llmConfig.model})`
      : 'worker: LLM narrator off (no usable LLM_API_KEY); incidents keep template summaries',
  );

  const guard = (name: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } catch (err) {
      log.error({ err, job: name }, 'job failed');
    }
  };

  const boss = getBoss();
  if (boss) {
    await boss.work<ProcessEventsJob>(QUEUES.processEvents, { batchSize: 4 }, async (jobs) => {
      for (const j of Array.isArray(jobs) ? jobs : [jobs])
        await timeJob(QUEUES.processEvents, () =>
          processEvents((j as { data: ProcessEventsJob }).data),
        );
    });
    await boss.work<NarrateIncidentJob>(QUEUES.narrateIncident, async (jobs) => {
      for (const j of Array.isArray(jobs) ? jobs : [jobs])
        await timeJob(QUEUES.narrateIncident, () =>
          narrateIncident((j as { data: NarrateIncidentJob }).data.incidentId),
        );
    });
    await boss.work<AssessIncidentJob>(QUEUES.assessIncident, async (jobs) => {
      for (const j of Array.isArray(jobs) ? jobs : [jobs])
        await timeJob(QUEUES.assessIncident, () =>
          assessIncident((j as { data: AssessIncidentJob }).data.incidentId),
        );
    });
    await boss.work<NotifyIncidentJob>(QUEUES.notifyIncident, async (jobs) => {
      for (const j of Array.isArray(jobs) ? jobs : [jobs])
        await timeJob(QUEUES.notifyIncident, () =>
          notifyIncident((j as { data: NotifyIncidentJob }).data.incidentId),
        );
    });
    await boss.work<ExportProjectJob>(QUEUES.exportProject, async (jobs) => {
      for (const j of Array.isArray(jobs) ? jobs : [jobs])
        await timeJob(QUEUES.exportProject, () =>
          exportProject((j as { data: ExportProjectJob }).data.exportId),
        );
    });
    const cron = async (queue: string, expr: string, fn: () => Promise<unknown>) => {
      await boss.schedule(queue, expr);
      await boss.work(queue, async () => {
        await timeJob(queue, fn);
      });
    };
    await cron(QUEUES.sweep, '* * * * *', () => processEvents({}));
    await cron(QUEUES.blocklistExpiry, '* * * * *', blocklistExpiry);
    await cron(QUEUES.autoCloseNoise, '0 * * * *', async () => {
      await autoCloseNoise();
      await exportCleanup();
    });
    // Retention, credential hashing, project hard-delete and export expiry (data handling).
    await cron(QUEUES.retentionPurge, '0 3 * * *', dailyDataMaintenance);
    const digest = digestCron();
    if (digest) await cron(QUEUES.weeklyDigest, digest, () => weeklyDigest(new Date(), log));
    else await boss.unschedule(QUEUES.weeklyDigest).catch(() => {});
    log.info('worker: pg-boss handlers registered');
  } else {
    // Degraded mode: plain timers (single instance only).
    timers.push(
      setInterval(
        guard('sweep', () => processEvents({})),
        10_000,
      ),
    );
    timers.push(setInterval(guard('blocklist-expiry', blocklistExpiry), 60_000));
    timers.push(setInterval(guard('auto-close-noise', autoCloseNoise), 3_600_000));
    timers.push(
      setInterval(
        guard('export-cleanup', () => exportCleanup()),
        3_600_000,
      ),
    );
    timers.push(
      setInterval(
        guard('retention-purge', async () =>
          new Date().getUTCHours() === 3 ? dailyDataMaintenance() : undefined,
        ),
        3_600_000,
      ),
    );
    // Digest: an hourly check (DIGEST_CRON is not parsed here). It reports the last complete
    // week, so any hour from Monday 09:00 UTC on is right; the per-project, per-week claim in
    // digest_runs turns the repeats into no-ops.
    if (digestCron())
      timers.push(
        setInterval(
          guard('weekly-digest', async () => {
            const now = new Date();
            return now.getUTCDay() === 1 && now.getUTCHours() < 9
              ? undefined
              : weeklyDigest(now, log);
          }),
          3_600_000,
        ),
      );
    log.warn('worker: running in degraded timer mode (no pg-boss)');
  }
  timers.push(setInterval(guard('sensor-staleness', sensorStaleness), 30_000));
  // Pick up anything left unprocessed from before this boot.
  void guard('boot-sweep', () => processEvents({}))();
}

export function stopWorker(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}
