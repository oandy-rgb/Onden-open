// What a browser-app copy keeps about itself, beside the workspace's data (table browser_app_state): which sample
// notes were made here, whether this copy has its own node id. One row per key. The table is made on first use, not
// by a migration: only the browser app has it (a server's database never does).
import { sql } from "kysely";
import { db } from "../dbKysely.js";

const ensureTable = () => sql`CREATE TABLE IF NOT EXISTS browser_app_state (key text PRIMARY KEY, value jsonb NOT NULL)`.execute(db);

/** The value kept under `key` in this copy, or undefined when nothing was ever kept. */
export async function readAppState<T>(key: string): Promise<T | undefined> {
  await ensureTable();
  return (await sql<{ value: T }>`SELECT value FROM browser_app_state WHERE key = ${key}`.execute(db)).rows[0]?.value;
}

/** Keep `value` under `key` in this copy (replacing what was there). */
export async function writeAppState(key: string, value: unknown): Promise<void> {
  await ensureTable();
  await sql`INSERT INTO browser_app_state (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(db);
}

/** Forget what was kept under `key`. */
export async function clearAppState(key: string): Promise<void> {
  await ensureTable();
  await sql`DELETE FROM browser_app_state WHERE key = ${key}`.execute(db);
}
