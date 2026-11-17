// The names of the databases a single-process distributed-sync test makes on a real Postgres, and how they are found and dropped.
// No pool and no db.js here: the suite's global setup uses it before any worker exists.
import { randomUUID } from "node:crypto";
import pg from "pg";

export const NODE_DATABASE_PREFIX = "onden_node_";
/** Databases a crashed run leaves behind are recognised by this name. */
export const NODE_DATABASE_PATTERN = /^onden_node_(\d{10,})_[0-9a-f]+_[a-z0-9_]+$/;
/** What makes a database disposable for the suite (the rule is scripts/lib/disposableDb.mjs'; every name here ends so). */
export const NODE_DATABASE_SUFFIX = "_test";
export const isNodeDatabase = (name: string): boolean => name.endsWith(NODE_DATABASE_SUFFIX) && NODE_DATABASE_PATTERN.test(name);

/** Set by the suite's global setup, once per run, so every worker and every file of the run name their databases the same way. */
export const RUN_ENV = "ONDEN_NODE_RUN";
export const runId = (): string => {
  process.env[RUN_ENV] ??= `${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  return process.env[RUN_ENV]!;
};

export const baseUrl = process.env.DATABASE_URL ?? "";
export const urlOfDatabase = (database: string): string => { const url = new URL(baseUrl); url.pathname = `/${database}`; return url.toString(); };
export const quotedIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function withServer<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlOfDatabase("postgres") });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}


/** Every database of the run `run` (nodes and the template), and with `staleRuns` also those of any other run that nothing is connected
 *  to (what a crashed run left). Two suites on one server would already destroy each other's shared database (globalSetup rebuilds it
 *  with FORCE), so a database of another run that is idle is a leftover, not a neighbour's. */
export async function dropNodeDatabases(options: { run?: string; staleRuns?: boolean; keep?: string } = {}): Promise<string[]> {
  return withServer(async (admin) => {
    const rows = (await admin.query<{ datname: string; sessions: string }>(
      `SELECT d.datname, (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname)::text AS sessions FROM pg_database d WHERE d.datname LIKE 'onden\\_node\\_%'`)).rows;
    const dropped: string[] = [];
    for (const { datname, sessions } of rows) {
      if (!isNodeDatabase(datname)) continue;
      const ofThisRun = options.run !== undefined && datname.startsWith(`${NODE_DATABASE_PREFIX}${options.run}_`);
      const stale = options.staleRuns === true && Number(sessions) === 0 && !datname.startsWith(`${NODE_DATABASE_PREFIX}${options.keep ?? ""}_`);
      if (!ofThisRun && !stale) continue;
      await admin.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(datname)} WITH (FORCE)`);
      dropped.push(datname);
    }
    return dropped;
  });
}
