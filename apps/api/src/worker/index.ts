import type { FastifyBaseLogger } from 'fastify';
import {
  getBoss,
  type NarrateIncidentJob,
  type AssessIncidentJob,
  type ProcessEventsJob,
  QUEUES,
  setInProcessNarrator,
  setInProcessAssessor,
  setInProcessProcessor,
} from '../jobs/queue.js';
import { loadDetection } from './detection.js';
import { autoCloseNoise, blocklistExpiry, retentionPurge, sensorStaleness } from './maintenance.js';
import { llmConfig, narrateIncident } from './narrator.js';
import { processEvents } from './process-events.js';
import { assessIncident } from './assess-incident.js';

const timers: NodeJS.Timeout[] = [];

/** Register queue handlers + schedules (ROLE=worker|all). Falls back to timers when pg-boss is unavailable. */
export async function startWorker(log: FastifyBaseLogger): Promise<void> {
  const det = await loadDetection();
  void det;
  setInProcessProcessor(processEvents);
  setInProcessNarrator(narrateIncident);
  setInProcessAssessor(assessIncident);
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
        await processEvents((j as { data: ProcessEventsJob }).data);
    });
    await boss.work<NarrateIncidentJob>(QUEUES.narrateIncident, async (jobs) => {
      for (const j of Array.isArray(jobs) ? jobs : [jobs])
        await narrateIncident((j as { data: NarrateIncidentJob }).data.incidentId);
    });
    await boss.work<AssessIncidentJob>(QUEUES.assessIncident, async (jobs) => {
      for (const j of Array.isArray(jobs) ? jobs : [jobs])
        await assessIncident((j as { data: AssessIncidentJob }).data.incidentId);
    });
    const cron = async (queue: string, expr: string, fn: () => Promise<unknown>) => {
      await boss.schedule(queue, expr);
      await boss.work(queue, async () => {
        await fn();
      });
    };
    await cron(QUEUES.sweep, '* * * * *', () => processEvents({}));
    await cron(QUEUES.blocklistExpiry, '* * * * *', blocklistExpiry);
    await cron(QUEUES.autoCloseNoise, '0 * * * *', autoCloseNoise);
    await cron(QUEUES.retentionPurge, '0 3 * * *', retentionPurge);
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
        guard('retention-purge', async () =>
          new Date().getUTCHours() === 3 ? retentionPurge() : undefined,
        ),
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
