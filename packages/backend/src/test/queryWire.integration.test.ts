// Trust-boundary wire query API (/api/query) against a real Postgres.
//
// Covers the round-2 extension: range operators (gt/gte/lt/lte) on both
// built-in columns and node_attributes, attribute-keyed sort, and cursor
// pagination — exercising the SAME shared filter compiler (sqlClauses.ts)
// that executeView uses, so the wire path and saved views agree.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId } from "../db.js";
import queryRouter from "../routes/query.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// An admin member of the default space, where the raw-SQL fixtures land.
let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/query", queryRouter);

type Row = { id: string; title: string; slug: string; updated_at: string };
type Result = { rows: Row[]; total: number; next: number | null };

async function query(body: unknown): Promise<Result> {
  const res = await app.request("/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<Result>;
}

describe.skipIf(!isTestDb)("wire query API — ranges, attr-sort, pagination (DB)", () => {
  let WS = "";

  beforeAll(async () => {
    WS = await getWorkspaceId();
    currentActor = await persistActor(WS, { id: "qw-admin", name: "Admin", role: "admin", type: "human" });

    const mk = async (title: string, attrs: Record<string, string>) => {
      const slug = `qw-${title}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const id = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden, sort_order)
         VALUES ($1,'manual','content',$2,$3,'x',false,0) RETURNING id`,
        [WS, title, slug],
      )).rows[0]!.id;
      for (const [key, value] of Object.entries(attrs)) {
        // Round-1's typed range filter keys off value_type (number/date arms).
        // qw_marker is a plain tag → 'text'; everything else here is numeric.
        const valueType = key === "qw_marker" ? "text" : "number";
        await seedQ(
          `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (node_id, key) DO UPDATE SET value = EXCLUDED.value, value_type = EXCLUDED.value_type`,
          [WS, id, key, value, valueType],
        );
      }
      return id;
    };

    // Clean any prior run's fixtures (titles are namespaced with a marker attr).
    await seedQ(
      `DELETE FROM content_nodes WHERE workspace_id = $1
         AND id IN (SELECT node_id FROM node_attributes WHERE key = 'qw_marker')`,
      [WS],
    );

    // Books published across years (numeric attr) for range tests.
    await mk("book-1995", { qw_marker: "1", year: "1995", price: "9" });
    await mk("book-2009", { qw_marker: "1", year: "2009", price: "100" });
    await mk("book-2020", { qw_marker: "1", year: "2020", price: "30" });
    await mk("book-2024", { qw_marker: "1", year: "2024", price: "7" });
  });

  const onlyFixtures = (r: Result) => r.rows.filter((x) => x.title.startsWith("book-"));

  it("numeric attribute gte uses numeric (not lexicographic) ordering", async () => {
    const r = await query({ where: { qw_marker: "1", year: { op: "gte", value: "2020" } } });
    const titles = onlyFixtures(r).map((x) => x.title).sort();
    expect(titles).toEqual(["book-2020", "book-2024"]);
  });

  it("numeric attribute lt — price < 10 catches '9' and '7' but not '100'", async () => {
    // Lexicographically "100" < "9"; numeric-aware comparison must exclude 100.
    const r = await query({ where: { qw_marker: "1", price: { op: "lt", value: "10" } } });
    const titles = onlyFixtures(r).map((x) => x.title).sort();
    expect(titles).toEqual(["book-1995", "book-2024"]);
  });

  it("bare-string where value still means eq (backward compatible)", async () => {
    const r = await query({ where: { qw_marker: "1", year: "2009" } });
    expect(onlyFixtures(r).map((x) => x.title)).toEqual(["book-2009"]);
  });

  it("sorts by an attribute value (descending)", async () => {
    const r = await query({ where: { qw_marker: "1" }, sort: "-year" });
    expect(onlyFixtures(r).map((x) => x.title)).toEqual([
      "book-2024", "book-2020", "book-2009", "book-1995",
    ]);
  });

  it("paginates: limit + next offset walks the full set without overlap; total is the whole match", async () => {
    const page1 = await query({ where: { qw_marker: "1" }, sort: "year", limit: 2 });
    expect(page1.rows.length).toBe(2);
    expect(page1.next).toBe(2);
    expect(page1.total).toBe(4);
    const page2 = await query({ where: { qw_marker: "1" }, sort: "year", limit: 2, offset: page1.next! });
    expect(page2.rows.length).toBe(2);
    expect(page2.next).toBeNull(); // exactly 4 fixtures, no 5th page
    expect(page2.total).toBe(4);
    const seen = [...page1.rows, ...page2.rows].map((x) => x.id);
    expect(new Set(seen).size).toBe(4); // no overlap
  });

  it("an offset past the end still answers the total (attribute sort parameters stay bound)", async () => {
    const r = await query({ where: { qw_marker: "1" }, sort: "-year", limit: 2, offset: 10 });
    expect(r.rows).toEqual([]);
    expect(r.next).toBeNull();
    expect(r.total).toBe(4);
  });
});
