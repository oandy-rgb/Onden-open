// `child:` prefix attributes (services/childAttributes.ts): a parent's
// `child:status = todo` gives every new direct child `status = todo`.
// The parent's row was filtered out by `NOT LIKE '_%'` — `_` is a LIKE
// wildcard, so that excluded every key and nothing was ever copied.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

let actor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/nodes", nodeRouter);

const send = (method: string, path: string, body: unknown) => app.request(path, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

async function attributes(nodeId: string) {
  const rows = await q<{ key: string; value: string; source: string }>(
    "SELECT key, value, source FROM node_attributes WHERE node_id = $1 ORDER BY key", [nodeId]);
  return Object.fromEntries(rows.rows.map((r) => [r.key, { value: r.value, source: r.source }]));
}

describe.skipIf(!isTestDb)("child: attributes", () => {
  let workspaceId: string;
  // Only this file's notes are cleaned up: the default workspace is shared.
  const stamp = Date.now();

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Test', 'default')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    )).rows[0]!.id;
    // Editing needs only an edit member; the shared default workspace's owner is not touched.
    actor = await persistActor(workspaceId, { id: "", name: "Owner", role: "editor", type: "human" });
  });

  afterAll(async () => {
    await seedQ("DELETE FROM content_nodes WHERE workspace_id = $1 AND title LIKE $2", [workspaceId, `% ${stamp}`]);
    await pool.end();
  });

  it("a new child gets the parent's child: values; its own markdown still wins and reserved keys stay behind", async () => {
    const parent = await send("POST", "/api/nodes", { title: `Project ${stamp}`, markdown: "" });
    expect(parent.status).toBe(201);
    const parentId = ((await parent.json()) as { id: string }).id;
    for (const [key, value] of [["child:status", "todo"], ["child:priority", "low"], ["child:_internal", "x"], ["owner", "ada"]]) {
      expect((await send("PUT", `/api/nodes/${parentId}/attributes/${encodeURIComponent(key)}`, { value })).status).toBe(200);
    }

    const child = await send("POST", "/api/nodes", { title: `Task ${stamp}`, markdown: "priority:: high", parent_id: parentId });
    expect(child.status).toBe(201);
    const childAttributes = await attributes(((await child.json()) as { id: string }).id);

    expect(childAttributes.status).toEqual({ value: "todo", source: "derived" });
    expect(childAttributes.priority).toEqual({ value: "high", source: "markdown" });
    expect(childAttributes).not.toHaveProperty("_internal");
    expect(childAttributes).not.toHaveProperty("owner");
    expect(childAttributes).not.toHaveProperty("child:status");
    // The copy is one-shot: the parent keeps its own rows.
    expect((await attributes(parentId))["child:status"]?.value).toBe("todo");
  });
});
