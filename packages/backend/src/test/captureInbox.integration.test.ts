// The capture module's tag (收件匣): made the first time a capture needs it, by
// any member who may write; asking again answers the same tag; a top-level tag
// that already has the name makes the module tag take the next free one; and a
// capture is born with the tag and the `_captured` flag in one request.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import { withIdempotencyKey } from "../spine/idempotency.js";
import nodes from "../routes/nodes.js";
import captureRouter from "../modules/capture/routes.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let ws = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));

function post(actor: ActorCtx, path: string, body: unknown, key: string = randomUUID()) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await withIdempotencyKey(c.req.header("Idempotency-Key") ?? randomUUID(), next);
  });
  app.route("/api/capture", captureRouter);
  app.route("/api/nodes", nodes);
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

const tagRow = async (id: string) => (await q<{ title: string; parent_id: string | null; tag_schema: { module?: string } | null }>(
  `SELECT title, parent_id, tag_schema FROM content_nodes WHERE id = $1`, [id],
)).rows[0];

describe.skipIf(!isTestDb)("POST /api/capture/inbox", () => {
  let editor: ActorCtx = { id: "", name: "Editor", role: "editor", type: "human" };

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('capture inbox', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    editor = await persistActor(ws, editor);
  });

  it("an editor makes the module tag once; asking again answers the same tag", async () => {
    const first = await post(editor, "/api/capture/inbox", {});
    expect(first.status).toBe(200);
    const { tag_id: id } = await first.json() as { tag_id: string };
    const row = await tagRow(id);
    expect(row).toMatchObject({ title: "收件匣", parent_id: null });
    expect(row!.tag_schema?.module).toBe("capture");

    const again = await post(editor, "/api/capture/inbox", {});
    expect(await again.json()).toEqual({ tag_id: id });
    const events = (await q(`SELECT 1 FROM domain_events WHERE target_id = $1`, [id])).rowCount;
    expect(events).toBe(1);
  });

  it("a note is created WITH the tag and the _captured flag in one request", async () => {
    const { tag_id } = await (await post(editor, "/api/capture/inbox", {})).json() as { tag_id: string };
    const id = randomUUID();
    const res = await post(editor, "/api/nodes", {
      id, title: "buy milk", markdown: "buy milk", parent_id: null,
      tag_ids: [tag_id], attributes: [{ key: "_captured", value: "true" }],
    }, id);
    expect(res.status).toBe(201);
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [id, tag_id])).rowCount).toBe(1);
    expect((await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_captured'`, [id])).rows[0]?.value).toBe("true");
  });

  it("an actor who may write in no space is refused and no tag is made", async () => {
    const other = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('capture viewer', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    // A person always writes in their own personal space (so a view-only member
    // may capture, as they may make #task); an agent with view-only access writes nowhere.
    const outsider = await persistActor(other, { id: "", name: "Viewer", role: "viewer", type: "agent" });
    const saved = ws;
    ws = other;
    try {
      const res = await post(outsider, "/api/capture/inbox", {});
      expect(res.status).toBe(403);
      expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND tag_schema->>'module' = 'capture'`, [other])).rowCount).toBe(0);
    } finally { ws = saved; }
  });

  it("a top-level tag already named 收件匣 stays; the module tag takes the next free name", async () => {
    const other = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('capture taken', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    const member = await persistActor(other, { id: "", name: "Editor", role: "editor", type: "human" });
    const saved = ws;
    ws = other;
    try {
      await seedQ(
        `INSERT INTO content_nodes (id, workspace_id, node_type, title, slug, markdown, source_type, tag_color)
         VALUES ($1, $2, 'class_tag', '收件匣', $3, '', 'manual', '#888888')`, [randomUUID(), other, `own-${randomUUID()}`],
      );
      const res = await post(member, "/api/capture/inbox", {});
      const { tag_id } = await res.json() as { tag_id: string };
      expect((await tagRow(tag_id))!.title).toBe("捕捉");
    } finally { ws = saved; }
  });
});
