import { buildApp } from './app.js';
import { sql } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { env, roleHasApi, roleHasWorker } from './env.js';
import { setInProcessNarrator, setInProcessProcessor, startBoss, stopBoss } from './jobs/queue.js';
import { hub } from './plugins/sse.js';
import { startWorker, stopWorker } from './worker/index.js';
import { narrateIncident } from './worker/narrator.js';
import { processEvents } from './worker/process-events.js';

async function main(): Promise<void> {
  const app = await buildApp();
  const log = app.log;
  log.info({ role: env.ROLE, node_env: env.NODE_ENV }, 'LXS API starting');

  // Fail fast if Postgres is unreachable; apply migrations (idempotent).
  try {
    await sql`select 1`;
    await runMigrations();
  } catch (err) {
    log.error({ err }, 'database unavailable or migration failed');
    process.exit(1);
  }

  // Queue is used by every role (ingest enqueues); only the worker role consumes.
  await startBoss(log);
  if (roleHasApi) {
    await hub.start(log);
    setInProcessProcessor(processEvents); // used only if pg-boss is down and this is an API node
    setInProcessNarrator(narrateIncident);
  }
  if (roleHasWorker) await startWorker(log);

  if (roleHasApi) {
    await app.listen({ host: env.HOST, port: env.PORT });
  } else {
    log.info('ROLE=worker: HTTP server not started');
  }

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    stopWorker();
    await app.close().catch(() => {});
    await stopBoss();
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
