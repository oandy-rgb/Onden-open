// A calculated field's "only count items tagged …" (scan 06 S3), random children and name spellings.
// Invariant: the count equals the descendants that carry the tag, whether the field's tag is written
// "task" or "#task" (the editor's hint shows the hash), and the answer carries no sentence of its own.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/rollupTagName.property.integration.test.ts
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../../httpError.js";
import { q, pool } from "../../db.js";
import nodesRouter from "../../routes/nodes.js";
import tagsRouter from "../../routes/tags.js";
import { persistActor } from "../helpers/persistActor.js";
import { checkAsync } from "../helpers/propsConfig.js";
import type { ActorCtx } from "../../types.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));
let owner: ActorCtx;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", owner); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/tags", tagsRouter);

async function json(method: string, path: string, body?: unknown): Promise<any> {
  const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(res.status, `${method} ${path}: ${await res.clone().text()}`).toBeLessThan(300);
  return res.json();
}

let projectTagId = "";
let taskTagId = "";
beforeAll(async () => {
  if (!isTestDb) return;
  WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Rollup', $1) RETURNING id::text`, [`rollup-${randomUUID()}`])).rows[0]!.id;
  owner = await persistActor(WS, { id: "ru-owner", name: "Owner", role: "admin", type: "human" });
  projectTagId = (await json("POST", "/api/tags", { name: "project" })).id;
  taskTagId = (await json("POST", "/api/tags", { name: "task" })).id;
});
afterAll(async () => { if (isTestDb) await pool.end(); });

async function countFor(tagSpelling: string, children: boolean[]): Promise<{ count: number; row: Record<string, unknown> }> {
  await json("PATCH", `/api/tags/${projectTagId}/schema`, { fields: [{ name: "open_tasks", type: "number", rollup: { op: "count", tag: tagSpelling } }] });
  const parent = await json("POST", "/api/nodes", { title: `p${randomUUID().slice(0, 6)}`, markdown: "x", tag_ids: [projectTagId] });
  for (const tagged of children) {
    await json("POST", "/api/nodes", { title: `c${randomUUID().slice(0, 6)}`, markdown: "x", parent_id: parent.id, ...(tagged ? { tag_ids: [taskTagId] } : {}) });
  }
  const rows = await json("GET", `/api/nodes/${parent.id}/rollup-attributes`) as Array<Record<string, unknown>>;
  const row = rows.find((r) => r.key === "open_tasks")!;
  return { count: row.value as number, row };
}

describe.skipIf(!isTestDb)("a calculated field's tag name", () => {
  it("random children, with and without the hash", async () => {
    await checkAsync(fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 5 }), fc.constantFrom("task", "#task", "TASK"), async (children, spelling) => {
      const { count, row } = await countFor(spelling, children);
      expect(count, `${spelling} over ${JSON.stringify(children)}`).toBe(children.filter(Boolean).length);
      expect(row.description).toBeUndefined();
    }), 15);
  }, 300_000);

  it("S3: a tag written #task counts the notes tagged task", async () => {
    expect((await countFor("#task", [true, true, false])).count).toBe(2);
  });
});
