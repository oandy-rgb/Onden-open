// The backend allowlist rules applied to ONE file: which detector runs on it, which owners exempt it, and
// what to tell the author. allowlist.guard.test.ts (every file, against the baseline) and
// scripts/checkEditedFile.mjs (the file an agent just wrote) both call backendViolations, so a rule added
// here is enforced in both places.
import { asyncHooksLines, consoleLines, pgDriverLines, rawSqlLines, routeSqlLines, processEnvLines, relativeImportSites, setIntervalLines, sqlInterpolationSites } from "./detect.js";
import { ASYNC_HOOKS_OWNERS, CONSOLE_OWNERS, PG_DRIVER_OWNERS, importAllowed, inOwners, isRouteFile, PROCESS_ENV_OWNERS, RAW_SQL_OWNERS, ROUTE_IMPORTS, ROUTE_SQL_OWNERS, SET_INTERVAL_OWNERS, SQL_FRAGMENT_HELPERS, SQL_TEXT_EXEMPT } from "./owners.js";

const SQL_HELPER_NAMES: ReadonlySet<string> = new Set(Object.keys(SQL_FRAGMENT_HELPERS));

export interface Violation { rule: string; line: number; what: string; owner: string }
export interface RuleMeta { what: string; owner: string }

export const RULE_META: Record<string, RuleMeta> = {
  "be-route-imports": {
    what: "an import from outside services/, spine/, httpError and the parse helpers (e.g. db)",
    owner: "the service that owns the rows (services/) or spine/mutate.ts; a route does not reach the database or modules itself",
  },
  "be-process-env": { what: "process.env", owner: "config.ts" },
  "be-set-interval": { what: "setInterval", owner: "backgroundJobs.ts startPeriodicJob (periodic work) or ticker.ts startTicker (one open stream)" },
  "be-async-hooks": { what: "node:async_hooks (AsyncLocalStorage)", owner: "requestContext.ts createContextSlot" },
  "be-pg-driver": { what: "an import of the `pg` driver", owner: "db.ts (pool, q, withTransaction): it chooses real Postgres or PGlite" },
  "be-console": { what: "console.*", owner: "logger.ts" },
  "be-sql-interpolation": {
    what: "a ${} in SQL text that is not a constant, a registered fragment helper or a sqlInt()/sqlIdentifier() value",
    owner: "a $n parameter for a value; for SQL text a constant (ALL_CAPS), a registered fragment helper (owners.ts SQL_FRAGMENT_HELPERS), sqlInt(n) for a number or sqlIdentifier(name) for a table or column name (sqlText.ts)",
  },
  "be-raw-sql": { what: "hand-written SQL (`q(` or `<client>.query(`)", owner: "db from dbKysely.ts (typed Kysely): `await db.selectFrom(\"workspaces\").select(\"id\").where(\"slug\", \"=\", slug).execute()`" },
  "be-route-pool-query": { what: "SQL (`.query(` or `q(`) in a route", owner: "the service that owns the rows (services/) or readPolicy for reads" },
};

/** Whether the allowlist guards look at this file at all (`rel` is the path under src/). Tests and test helpers are not app code. */
export function isGuardedSource(rel: string): boolean {
  return rel.endsWith(".ts") && !rel.endsWith(".test.ts") && !rel.split("/").includes("test");
}

/** Violations in one file (`rel` is its path under src/). Counting against the baseline is the caller's job. */
export function backendViolations(rel: string, source: string): Violation[] {
  if (!isGuardedSource(rel)) return [];
  const out: Violation[] = [];
  const add = (rule: string, lines: number[]) => { for (const line of lines) out.push({ rule, line, ...RULE_META[rule]! }); };
  const isRoute = rel.startsWith("routes/");
  const isRouteSql = isRouteFile(rel);
  if (isRoute) add("be-route-imports", relativeImportSites(rel, source).filter(({ target }) => !importAllowed(target, ROUTE_IMPORTS)).map(({ line }) => line));
  if (!inOwners(rel, PROCESS_ENV_OWNERS)) add("be-process-env", processEnvLines(rel, source));
  if (!inOwners(rel, SET_INTERVAL_OWNERS)) add("be-set-interval", setIntervalLines(rel, source));
  if (!inOwners(rel, ASYNC_HOOKS_OWNERS)) add("be-async-hooks", asyncHooksLines(rel, source));
  if (!inOwners(rel, PG_DRIVER_OWNERS)) add("be-pg-driver", pgDriverLines(rel, source));
  if (!inOwners(rel, CONSOLE_OWNERS)) add("be-console", consoleLines(rel, source));
  if (!inOwners(rel, SQL_TEXT_EXEMPT)) add("be-sql-interpolation", sqlInterpolationSites(rel, source, SQL_HELPER_NAMES).map(({ line }) => line));
  if (!inOwners(rel, RAW_SQL_OWNERS)) add("be-raw-sql", rawSqlLines(rel, source));
  if (isRouteSql && !inOwners(rel, ROUTE_SQL_OWNERS)) add("be-route-pool-query", routeSqlLines(rel, source));
  return out;
}
