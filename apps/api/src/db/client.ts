import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

/** Raw postgres.js client (also used for LISTEN/NOTIFY). */
export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  onnotice: () => {},
  connect_timeout: 10,
});

export const db = drizzle(sql, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;
export { schema };
