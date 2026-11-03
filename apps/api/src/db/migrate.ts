import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sql } from './client.js';

const folder = fileURLToPath(new URL('./migrations', import.meta.url));

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}

// Allow `pnpm db:migrate` as a script.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMigrations()
    .then(async () => {
      console.log('migrations applied');
      await sql.end();
    })
    .catch(async (err) => {
      console.error(err);
      await sql.end();
      process.exit(1);
    });
}
