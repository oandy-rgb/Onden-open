// D66: list paging has one contract (services/paging.ts). Real PostgreSQL:
//   (1) /api/versions/recent?limit=abc reached SQL as LIMIT 'NaN' → 500;
//   (2) a tag view with ?limit=-5 became LIMIT -4 → 500;
//   (3) a saved view of a 350-note tag answered 200 rows and no total, so the
//       table summed 200 rows with no "more";
//   (4) a query block's count was the page length ("50 matches" for 120).
// Bad input is now a 400; paged lists answer { rows, total?, next }.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { q, getWorkspaceId } from "../db.js";
import { apiOnError } from "../httpError.js";
import type { ActorCtx } from "../types.js";
import tagsRouter from "../routes/tags.js";
import versionsRouter from "../routes/versions.js";
import queryRouter from "../routes/query.js";
import eventsRouter from "../routes/events.js";
import inboxRouter from "../routes/inbox.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { seedView } from "./helpers/seedView.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/tags", tagsRouter);
app.route("/api/versions", versionsRouter);
app.route("/api/query", queryRouter);
app.route("/api/events", eventsRouter);
app.route("/api/inbox", inboxRouter);

type ExecPage = { rows: Array<{ id: string; attributes: Record<string, string | null> }>; total: number; next: number | null };

describe.skipIf(!isTestDb)("list paging contract (D66)", () => {
  const STAMP = Date.now();
  const TAG = `paging-${STAMP}`;
  let tagId = "", viewId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const ws = await getWorkspaceId();
    currentActor = await persistActor(ws, { id: `paging-admin-${STAMP}`, name: "Admin", role: "admin", type: "human" });
    tagId = (await seedClassTag(ws, {
      name: TAG, slug: TAG, title: TAG, nodeSlug: `tag-${TAG}`,
      fields: [{ name: "price", type: "number" }],
    })).tagId;
    viewId = await seedView(tagId, { name: "All", layout: "table", visible_fields: ["title", "price"] });
    // 350 tagged notes, each with price 1.
    await seedQ(
      `WITH made AS (
         INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden, sort_order)
         SELECT $1, 'manual', 'content', 'paging note ' || i, $2 || '-' || i, 'x', false, i
           FROM generate_series(1, 350) i
         RETURNING id
       ), tagged AS (
         INSERT INTO node_tags (node_id, tag_id) SELECT id, $3 FROM made RETURNING node_id
       )
       INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type)
       SELECT $1, node_id, 'price', '1', 'number' FROM tagged`,
      [ws, `paging-${STAMP}`, tagId],
    );
  });

  it("(1) /api/versions/recent?limit=abc is a 400, not a 500; a good limit answers a page", async () => {
    const bad = await app.request("/api/versions/recent?limit=abc");
    expect(bad.status).toBe(400);
    expect((await app.request("/api/versions/recent?offset=-1")).status).toBe(400);
    const good = await app.request("/api/versions/recent?limit=5");
    expect(good.status).toBe(200);
    const body = await good.json() as { rows: unknown[]; next: number | null };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBeLessThanOrEqual(5);
    expect(body).toHaveProperty("next");
  });

  it("(2) a tag view with ?limit=-5 (or abc, or offset=x) is a 400, not a 500", async () => {
    for (const qs of ["limit=-5", "limit=abc", "limit=0", "offset=x", "offset=99999999999"]) {
      const res = await app.request(`/api/tags/${tagId}/views/${viewId}/exec?${qs}`);
      expect(res.status, qs).toBe(400);
    }
  });

  it("(3) a saved view of a 350-note tag says total 350 and pages on to the rest", async () => {
    const first = await (await app.request(`/api/tags/${tagId}/views/${viewId}/exec`)).json() as ExecPage;
    expect(first.rows.length).toBe(200);
    expect(first.total).toBe(350);
    expect(first.next).toBe(200);
    const second = await (await app.request(`/api/tags/${tagId}/views/${viewId}/exec?offset=${first.next}`)).json() as ExecPage;
    expect(second.rows.length).toBe(150);
    expect(second.total).toBe(350);
    expect(second.next).toBeNull();
    const ids = new Set([...first.rows, ...second.rows].map((r) => r.id));
    expect(ids.size).toBe(350);
    // Past the end: no rows, the total still known.
    const past = await (await app.request(`/api/tags/${tagId}/views/${viewId}/exec?offset=400`)).json() as ExecPage;
    expect(past).toMatchObject({ rows: [], total: 350, next: null });
  });

  it("(4) a query block's answer carries the whole match count, not the page length", async () => {
    const res = await app.request("/api/query", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [TAG] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: unknown[]; total: number; next: number | null };
    expect(body.rows.length).toBe(50);
    expect(body.total).toBe(350);
    expect(body.next).toBe(50);
  });

  it("events and inbox share the limit grammar: bad → 400", async () => {
    for (const path of ["/api/events?limit=abc", "/api/events?limit=-5", "/api/inbox?limit=abc", "/api/inbox?limit=0"]) {
      expect((await app.request(path)).status, path).toBe(400);
    }
    expect((await app.request("/api/events?limit=10000")).status).toBe(200); // clamped, not refused
  });
});
