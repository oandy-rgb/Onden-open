// Version lineage on the event log (migration 162): every event that changes a
// note body carries body_hash (after) and base_hash (the body it was made from),
// filled by db.ts insertEvent for every write path.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { restoreNodeVersion } from "../services/nodeUpdate.js";
import { duplicateNote } from "../services/noteDuplicate.js";
import { sha256Hex } from "../utils.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "body-hash-admin", name: "Body hash", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
const send = (url: string, method: string, body: unknown = {}) => app.request(url, {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const create = async (markdown: string) => {
  const res = await send("/nodes", "POST", { title: `bh ${randomUUID()}`, markdown });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
};
const save = async (id: string, body: Record<string, unknown>) => {
  const res = await send(`/nodes/${id}`, "PATCH", body);
  expect(res.status, await res.clone().text()).toBe(200);
};
const bodyEvents = async (id: string) => (await q<{ id: string; event_type: string; body_hash: string | null; base_hash: string | null; payload_hash: string }>(
  `SELECT id::text, event_type, body_hash, base_hash, payload->>'body_hash' AS payload_hash
     FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash' ORDER BY domain_events.id`, [id])).rows;

describe.skipIf(!isTestDb)("body events record body_hash and base_hash (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Body hash',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  it("a create has no base; a save is based on the body it replaced", async () => {
    const id = await create("one");
    await save(id, { markdown: "two" });
    await save(id, { markdown: "three" });
    const events = await bodyEvents(id);
    // The create adds its own block ids, so compare to what the events say.
    expect(events.map((e) => e.event_type)).toEqual(["NODE_CREATED", "NODE_UPDATED", "NODE_UPDATED"]);
    expect(events.every((e) => e.body_hash === e.payload_hash)).toBe(true);
    expect(events[0]!.base_hash).toBeNull();
    expect(events[1]!.base_hash).toBe(events[0]!.body_hash);
    expect(events[2]!.base_hash).toBe(events[1]!.body_hash);
  });

  it("an editor save made from an older body records the older body as its base", async () => {
    const id = await create("a\n\nb\n\nc");
    const first = (await bodyEvents(id))[0]!;
    const base = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
    await save(id, { markdown: base.replace("a", "a2") });
    // A second writer still on `base` edits another line.
    await save(id, { markdown: base.replace("c", "c2"), base_markdown: base });
    const events = await bodyEvents(id);
    expect(events).toHaveLength(3);
    expect(events[2]!.base_hash).toBe(sha256Hex(base));
    expect(events[2]!.base_hash).toBe(first.body_hash);
  });

  it("version restore, event restore and duplicate all record both hashes", async () => {
    const id = await create("x");
    await save(id, { markdown: "y" });
    const [created, updated] = await bodyEvents(id);
    await restoreNodeVersion(workspaceId, id, created!.id, { actor });
    await restoreEvent(updated!.id, { actor, workspaceId });
    const copy = await duplicateNote({ workspaceId, actor, sourceId: id });
    const events = await bodyEvents(id);
    expect(events.map((e) => e.event_type)).toContain("NODE_RESTORED");
    for (const e of events) {
      expect(e.body_hash).toBe(e.payload_hash);
      if (e.event_type !== "NODE_CREATED") expect(e.base_hash, `${e.event_type} ${e.id}`).not.toBeNull();
    }
    const last = events.at(-1)!;
    expect(last.base_hash).toBe(events.at(-2)!.body_hash);
    const copied = (await bodyEvents(String(copy.node.id)))[0]!;
    expect(copied.body_hash).toBe(copied.payload_hash);
    expect(copied.base_hash).toBeNull();
  });

  it("guard: no event that changed a body lacks body_hash, and only a first version lacks base_hash", async () => {
    const missing = await q<{ id: string }>(
      `SELECT id::text FROM domain_events
        WHERE workspace_id = $1 AND payload ? 'body_hash' AND (body_hash IS DISTINCT FROM payload->>'body_hash')`, [workspaceId]);
    expect(missing.rows).toEqual([]);
    const baseless = await q<{ id: string }>(
      `SELECT e.id::text FROM domain_events e
        WHERE e.workspace_id = $1 AND e.body_hash IS NOT NULL AND e.base_hash IS NULL
          AND EXISTS (SELECT 1 FROM domain_events p WHERE p.target_id = e.target_id AND p.payload ? 'body_hash' AND p.id < e.id)`, [workspaceId]);
    expect(baseless.rows).toEqual([]);
  });
});
