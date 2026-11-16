// PATCH /api/nodes/:id must write ONLY the columns the request carries.
//
// Historically the handler read outside the transaction and wrote a merged
// snapshot, so a rename could overwrite a concurrent visibility change. The
// edit operation now reads under the event lock as well; it must still update
// only explicitly supplied fields and retain PATCH/default semantics.
//
// Pin: fire the two PATCHes concurrently, both fields must survive. After the
// fix this is deterministic (each PATCH's SET clause carries only its own
// keys, and the spine's per-workspace advisory lock serialises the writes);
// before the fix it failed whenever the pre-flights interleaved.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const admin: ActorCtx = { id: "npp-admin", name: "Admin", role: "admin", type: "human" };
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", admin); await next(); });
app.route("/api/nodes", nodesRouter);

const patch = (id: string, body: unknown) =>
  app.request(`/api/nodes/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe.skipIf(!isTestDb)("PATCH /api/nodes/:id partial update (DB)", () => {
  let WS = "";
  const stamp = Date.now();

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
  });

  async function seedNode(suffix: string): Promise<string> {
    const r = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden, order_key)
       VALUES ($1,'manual','content','npp before ${stamp}-${suffix}','npp-${stamp}-${suffix}','body', false, 'a0')
       RETURNING id`,
      [WS],
    );
    return r.rows[0]!.id;
  }

  it("concurrent PATCHes to different scalars both survive (no snapshot write-back)", async () => {
    // A few rounds over different field pairs — one interleaving is enough to
    // catch a clobber, and post-fix every round must be quiet. (presentation,
    // not hidden: only a tag can be hidden since D104.)
    const rounds: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ presentation: { theme: "r0" } }, { title: `npp after ${stamp}-r0` }],
      [{ order_key: "a7" }, { title: `npp after ${stamp}-r1` }],
      [{ presentation: { theme: "r2" } }, { order_key: "a7" }],
    ];
    for (let i = 0; i < rounds.length; i++) {
      const id = await seedNode(`r${i}`);
      const [a, b] = rounds[i]!;
      const [ra, rb] = await Promise.all([patch(id, a), patch(id, b)]);
      expect(ra.status).toBe(200);
      expect(rb.status).toBe(200);

      const row = (await q<{ title: string; presentation: unknown; order_key: string }>(
        `SELECT title, presentation, order_key FROM content_nodes WHERE id = $1`, [id],
      )).rows[0]!;
      const want = { ...a, ...b };
      if ("presentation" in want) expect(row.presentation, `round ${i}: presentation lost`).toEqual(want.presentation);
      if ("order_key" in want) expect(row.order_key, `round ${i}: order_key lost`).toBe(want.order_key);
      if ("title" in want) expect(row.title, `round ${i}: title lost`).toBe(want.title);
    }
  });

  it("a PATCH carrying only title leaves body, hidden and order_key untouched (zod defaults must not resurrect)", async () => {
    // DraftNode.partial() still applies .default() fields — before the fix a
    // title-only PATCH parsed as {title, markdown:'', hidden:false,
    // order_key:0} and WIPED the body / reset the flags. Deterministic,
    // sequential, no race needed.
    const id = await seedNode("defaults");
    await seedQ(`UPDATE content_nodes SET markdown = 'precious body', hidden = true, order_key = 'a5' WHERE id = $1`, [id]);
    expect((await patch(id, { title: `npp renamed ${stamp}` })).status).toBe(200);
    const row = (await q<{ markdown: string; hidden: boolean; order_key: string }>(
      `SELECT markdown, hidden, order_key FROM content_nodes WHERE id = $1`, [id],
    )).rows[0]!;
    expect(row.markdown).toBe("precious body");
    expect(row.hidden).toBe(true);
    expect(row.order_key).toBe("a5");
  });

  it("a PATCH carrying only order_key does not recompute the slug", async () => {
    const id = await seedNode("slug");
    const before = (await q<{ slug: string }>(`SELECT slug FROM content_nodes WHERE id = $1`, [id])).rows[0]!.slug;
    expect((await patch(id, { order_key: "a3" })).status).toBe(200);
    const after = (await q<{ slug: string }>(`SELECT slug FROM content_nodes WHERE id = $1`, [id])).rows[0]!.slug;
    expect(after).toBe(before);
  });

  // D64: a position among siblings is not an edit of the note.
  it("an order_key-only PATCH keeps updated_at and adds no version", async () => {
    const id = await seedNode("position");
    await seedQ(`UPDATE content_nodes SET updated_at = '2026-01-01T00:00:00Z' WHERE id = $1`, [id]);
    expect((await patch(id, { order_key: "a9" })).status).toBe(200);
    const row = (await q<{ order_key: string; updated_at: Date }>(
      `SELECT order_key, updated_at FROM content_nodes WHERE id = $1`, [id],
    )).rows[0]!;
    expect(row.order_key).toBe("a9");
    expect(row.updated_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    // The move is still an event (sync, undo), without a body version.
    const events = (await q<{ has_hash: boolean; prev: Record<string, unknown> }>(
      `SELECT payload ? 'body_hash' AS has_hash, tx_meta->'prev_field_values' AS prev
         FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_UPDATED'`, [id],
    )).rows;
    expect(events).toEqual([{ has_hash: false, prev: { order_key: "a0" } }]);
  });

  it("a PATCH with order_key and another field still counts as an edit", async () => {
    const id = await seedNode("position-and-title");
    await seedQ(`UPDATE content_nodes SET updated_at = '2026-01-01T00:00:00Z' WHERE id = $1`, [id]);
    expect((await patch(id, { order_key: "a2", title: `npp moved ${stamp}` })).status).toBe(200);
    const row = (await q<{ updated_at: Date }>(`SELECT updated_at FROM content_nodes WHERE id = $1`, [id])).rows[0]!;
    expect(row.updated_at.toISOString()).not.toBe("2026-01-01T00:00:00.000Z");
    const hashed = (await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_UPDATED' AND payload ? 'body_hash'`, [id],
    )).rows[0]!.n;
    expect(hashed).toBe(1);
  });
});
