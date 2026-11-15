// Self-test of the backend allowlist guards: every detector is fed a violating sample (must be caught) and a
// legal one (must pass). Without this a detector that silently stopped matching would leave the guard green forever.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asyncHooksLines, pgDriverLines, consoleUses, routeSqlUses, processEnvUses, relativeImportTargets, setIntervalUses, sqlInterpolationSites } from "./allowlist/detect.js";
import { compareToBaseline } from "../../../../../scripts/allowlistLib.mjs";
import { backendViolations, RULE_META } from "./allowlist/fileRules.js";
import { ownerCovered } from "../../../../../scripts/entrypointsCatalog.mjs";
import { ASYNC_HOOKS_OWNERS, CONSOLE_OWNERS, PG_DRIVER_OWNERS, importAllowed, inOwners, isRouteFile, PROCESS_ENV_OWNERS, RAW_SQL_OWNERS, ROUTE_IMPORTS, ROUTE_SQL_OWNERS, SET_INTERVAL_OWNERS, SQL_FRAGMENT_HELPERS } from "./allowlist/owners.js";

describe("process.env", () => {
  it("catches every way of reading it", () => {
    expect(processEnvUses("a.ts", `const a = process.env.X; const b = process.env["Y"]; const { Z } = process.env;`)).toBe(3);
  });
  it("lets other uses of env and process through", () => {
    expect(processEnvUses("a.ts", `const a = config.env.X; const b = process.cwd(); // process.env.X\nconst s = "process.env";`)).toBe(0);
  });
});

describe("setInterval", () => {
  it("catches bare and globalThis calls", () => {
    expect(setIntervalUses("a.ts", `setInterval(f, 1); globalThis.setInterval(f, 2);`)).toBe(2);
  });
  it("lets setTimeout, clearInterval and mentions through", () => {
    expect(setIntervalUses("a.ts", `setTimeout(f, 1); clearInterval(t); const n = "setInterval"; obj.setInterval(f);`)).toBe(0);
  });
});

describe("node:async_hooks and the pg driver", () => {
  it("catches static, dynamic and require forms", () => {
    expect(asyncHooksLines("a.ts", `import { AsyncLocalStorage } from "node:async_hooks"; const m = await import("async_hooks"); const r = require("node:async_hooks");`)).toEqual([1, 1, 1]);
    expect(pgDriverLines("a.ts", `import pg from "pg";\nimport type { Pool } from "pg";\nexport { x } from "pg/lib/x";`)).toEqual([1, 2, 3]);
  });
  it("lets other modules and mentions through", () => {
    expect(asyncHooksLines("a.ts", `import { x } from "./requestContext.js"; const s = "node:async_hooks"; // import "async_hooks"`)).toEqual([]);
    expect(pgDriverLines("a.ts", `import { pool } from "./db.js"; import p from "pg-promise"; const s = "pg";`)).toEqual([]);
  });
});

describe("console", () => {
  it("catches any console method", () => {
    expect(consoleUses("a.ts", `console.log(1); console.error(2); const c = console.warn;`)).toBe(3);
  });
  it("lets a logger and other names through", () => {
    expect(consoleUses("a.ts", `logger.info(1); const consoleish = 1; // console.log\nconst s = "console.log";`)).toBe(0);
  });
});

describe("SQL in a route", () => {
  it("catches .query on pool, a transaction client, db or tx", () => {
    expect(routeSqlUses("a.ts", `await pool.query("select 1"); await pool.query<Row>(sql, []);`)).toBe(2);
    expect(routeSqlUses("a.ts", `await client.query("select 1"); await db.query(\`select 1\`); await tx.query("select 1");`)).toBe(3);
  });
  it("catches the q() helper, with or without a row type", () => {
    expect(routeSqlUses("a.ts", `await q("select 1"); await q<Row>("select 1", []);`)).toBe(2);
  });
  it("lets request-parameter reads and non-calls through", () => {
    expect(routeSqlUses("a.ts", `c.req.query("limit"); c.req.query(); pool.end(); const p = pool.query; qux("x");`)).toBe(0);
  });
  it("covers a module's own routes.ts as well as routes/", () => {
    expect(isRouteFile("routes/nodes.ts")).toBe(true);
    expect(isRouteFile("modules/rss/routes.ts")).toBe(true);
    expect(isRouteFile("modules/rss/items.ts")).toBe(false);
    expect(isRouteFile("services/nodeUpdate.ts")).toBe(false);
  });
});

describe("hand-written SQL (be-raw-sql)", () => {
  const rawSql = (rel: string, source: string) => backendViolations(rel, source).filter((v) => v.rule === "be-raw-sql").length;
  it("counts q() and client.query in any app file, but not the SQL transport files", () => {
    const source = `await q("select 1"); await client.query("select 2");`;
    expect(rawSql("services/x.ts", source)).toBe(2);
    for (const owner of RAW_SQL_OWNERS) expect(rawSql(owner, source)).toBe(0);
  });
  it("lets the typed db through", () => {
    expect(rawSql("services/x.ts", `await db.selectFrom("workspaces").select("id").execute();`)).toBe(0);
  });
  it("says to use db, with an example", () => {
    const message = compareToBaseline("be-raw-sql", { "services/new.ts": 1 }, RULE_META["be-raw-sql"]!, { "be-raw-sql": {} }).errors[0]!;
    expect(message).toContain("services/new.ts：這個檔不准用");
    expect(message).toContain("db.selectFrom");
  });
});

describe("route imports", () => {
  const route = "routes/nodes.ts";
  const illegal = (code: string) => relativeImportTargets(route, code).filter((t) => !importAllowed(t, ROUTE_IMPORTS));
  it("resolves specifiers against the importing file", () => {
    expect(relativeImportTargets(route, `import a from "../services/x.js"; import b from "./params.js"; export { c } from "../httpError.js"; const d = await import("../db.js"); import e from "zod";`))
      .toEqual(["services/x", "routes/params", "httpError", "db"]);
  });
  it("catches an import of a layer a route may not use", () => {
    expect(illegal(`import { pool } from "../db.js";`)).toEqual(["db"]);
    expect(illegal(`import x from "../modules/rss/fetch.js";`)).toEqual(["modules/rss/fetch"]);
  });
  it("lets the listed layers and packages through", () => {
    expect(illegal(`import a from "../services/readPolicy.js"; import b from "../spine/mutate.js"; import c from "../httpError.js"; import d from "./params.js"; import z from "zod"; import { s } from "../utils.js"; import t from "../types.js";`)).toEqual([]);
  });
  it("a file owner is only itself, a folder owner covers its files", () => {
    expect(inOwners("config.ts", ["config.ts"])).toBe(true);
    expect(inOwners("services/config.ts", ["config.ts"])).toBe(false);
    expect(importAllowed("services/a/b", ["services/"])).toBe(true);
    expect(importAllowed("servicesX", ["services/"])).toBe(false);
  });
});

// 例外只能是唯一入口本身：owners.ts 的每個 owner 都要被 catalog 某個入口涵蓋（該入口的 rules 含這條規則，
// 且入口檔案就是這個 owner、或落在這個 owner 資料夾內）。route 可 import 的目標沒有副檔名，比對時忽略。
describe("every owner is a catalog entry", () => {
  const BE = "packages/backend/src/";
  const uncovered = (owners: readonly string[], rule: string) => owners.filter((o) => !ownerCovered(o, [rule], BE, undefined, true));
  const explain = (table: string, owners: string[]) =>
    owners.length === 0 ? "" : `${table}：${owners.join("、")} 不是唯一入口。例外只能是唯一入口本身，請改成走入口，或把它登記成 scripts/entrypoints.catalog.json 的入口（rules 要含這條規則）。`;
  it("each owner table", () => {
    expect(explain("ROUTE_IMPORTS", uncovered(ROUTE_IMPORTS, "be-route-imports"))).toBe("");
    expect(explain("PROCESS_ENV_OWNERS", uncovered(PROCESS_ENV_OWNERS, "be-process-env"))).toBe("");
    expect(explain("SET_INTERVAL_OWNERS", uncovered(SET_INTERVAL_OWNERS, "be-set-interval"))).toBe("");
    expect(explain("ASYNC_HOOKS_OWNERS", uncovered(ASYNC_HOOKS_OWNERS, "be-async-hooks"))).toBe("");
    expect(explain("PG_DRIVER_OWNERS", uncovered(PG_DRIVER_OWNERS, "be-pg-driver"))).toBe("");
    expect(explain("CONSOLE_OWNERS", uncovered(CONSOLE_OWNERS, "be-console"))).toBe("");
    expect(explain("RAW_SQL_OWNERS", uncovered(RAW_SQL_OWNERS, "be-raw-sql"))).toBe("");
    expect(explain("ROUTE_SQL_OWNERS", uncovered(ROUTE_SQL_OWNERS, "be-route-pool-query"))).toBe("");
  });
});

// SQL text assembled with ${}: values go through $n, text only from constants, registered helpers and the two validators.
describe("SQL interpolation", () => {
  const HELPERS = new Set(["readableScopeSql", "sqlInt", "sqlIdentifier", "textSearchEngine().build"]);
  const bad = (code: string) => sqlInterpolationSites("a.ts", code, HELPERS).map((s) => s.text);

  it("lets constants, registered helpers and validated values through", () => {
    expect(bad("const LIMIT_MAX = 5; await q(`SELECT ${COLS} FROM t LIMIT ${LIMIT_MAX + 1}`);")).toEqual([]);
    expect(bad("const scope = readableScopeSql(actor, \"n\", params);\nawait q(`SELECT 1 FROM n WHERE ${scope}`, params);")).toEqual([]);
    expect(bad("await pool.query(`SELECT 1 FROM ${sqlIdentifier(table)} LIMIT ${sqlInt(limit)}`);")).toEqual([]);
    expect(bad("await q(`SELECT 1 WHERE a = $${params.push(v)} AND b = $${params.length}`, params);")).toEqual([]);
    expect(bad("const text = (await textSearchEngine()).build(\"n\", q, params);\nawait q(`SELECT ${text.keywords}`, params);")).toEqual([]);
  });
  it("lets conditional, joined and pushed-together pieces of safe parts through", () => {
    expect(bad("const where = [`a = 1`, NOT_SYSTEM];\nif (x) where.push(`b = $${params.push(x)}`);\nawait q(`SELECT 1 WHERE ${where.join(\" AND \")} ${x ? \"LIMIT 1\" : \"\"}`);")).toEqual([]);
    expect(bad("const T = { a: { name: \"t1\" }, b: { name: \"t2\" } } as const;\nconst { name } = T[kind];\nawait q(`SELECT 1 FROM ${name}`);")).toEqual([]);
  });
  it("judges a local function by what it returns, its parameters being as safe as the arguments", () => {
    expect(bad("const f = (alias: string) => `${alias}.id`;\nawait q(`SELECT ${f(\"n\")} FROM n`);")).toEqual([]);
    expect(bad("const f = (alias: string) => `${alias}.id`;\nawait q(`SELECT ${f(req.alias)} FROM n`);")).toEqual(["f(req.alias)"]);
  });
  it("tells two variables of the same name in different functions apart", () => {
    expect(bad("function a(dir: string) { return dir; }\nfunction b() { const dir = \"ASC\"; return q(`SELECT 1 ORDER BY x ${dir}`); }")).toEqual([]);
  });

  it("fails an ordinary variable, a parameter or a request field in SQL text", () => {
    expect(bad("await q(`SELECT 1 FROM t WHERE a = ${value}`);")).toEqual(["value"]);
    expect(bad("function f(table: string) { return q(`SELECT 1 FROM ${table}`); }")).toEqual(["table"]);
    expect(bad("await q(`SELECT 1 FROM t ORDER BY ${req.sort}`);")).toEqual(["req.sort"]);
    expect(bad("await q(`SELECT 1 LIMIT ${limit}`);")).toEqual(["limit"]);
  });
  it("fails an unregistered helper, and a template that hides behind a variable or +", () => {
    expect(bad("await q(`SELECT 1 WHERE ${someSql(\"n\")}`);")).toEqual(['someSql("n")']);
    expect(bad("const sql = `SELECT 1 FROM ${table}`;\nawait q(sql);")).toEqual(["table"]);
    expect(bad("await q(\"SELECT 1 FROM \" + table);")).toEqual(["table"]);
    expect(bad("await q(prefix + \" FROM t\");")).toEqual(["prefix"]);
  });
  it("fails a value that reaches the text through an assignment, an append or an unregistered call", () => {
    expect(bad("let c = \"\";\nif (x) c += user;\nawait q(`SELECT 1 ${c}`);")).toEqual(["c"]);
    expect(bad("const where = [`a = 1`];\nwhere.push(`b = ${user}`);\nawait q(`SELECT 1 WHERE ${where.join(\" AND \")}`);")).toEqual(["where.join(\" AND \")"]);
    expect(bad("const where = [`a = 1`];\nmystery(where);\nawait q(`SELECT 1 WHERE ${where.join(\" AND \")}`);")).toEqual(["where.join(\" AND \")"]);
  });
  it("checks SQL text built inside a helper's argument, and every query method", () => {
    expect(bad("await q(`SELECT ${readableScopeSql(actor, `${alias}`, params)}`);")).toEqual(["alias"]);
    expect(bad("await client.query(`SELECT ${v}`); await tx.query(`SELECT ${w}`); await pool.query(`SELECT ${x}`);")).toEqual(["v", "w", "x"]);
  });
  it("does not look at values in the parameter list or at templates that are not queries", () => {
    expect(bad("await q(`SELECT 1 WHERE a = $1`, [`${user}`]); const msg = `hello ${name}`;")).toEqual([]);
  });
});

describe("registered SQL fragment helpers", () => {
  const SRC = join(import.meta.dirname, "..", "..");
  it("each one is still declared in the file named for it", () => {
    const missing = Object.entries(SQL_FRAGMENT_HELPERS).filter(([name, { file }]) => {
      const path = join(SRC, file);
      const declared = name.replace(/\(\)\..*$/, "");
      return !existsSync(path) || !new RegExp(`export (async )?(const|function) ${declared}\\b`).test(readFileSync(path, "utf8"));
    }).map(([name]) => name);
    expect(missing).toEqual([]);
  });
  it("each one has a reason", () => {
    expect(Object.entries(SQL_FRAGMENT_HELPERS).filter(([, { why }]) => why.trim().length < 10).map(([name]) => name)).toEqual([]);
  });
});
