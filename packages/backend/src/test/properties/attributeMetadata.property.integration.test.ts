// Random sequences of attribute writes through the real PUT route (scan 06 M1).
//
// Model: a value edit that does not name `is_inheritable` keeps the row's own
// flag; a value edit that names no `value_type` keeps the row's type while the
// new value still fits it, else the type the value shows (freeFormType).
// Invariant after every write: the stored row and the route's answer equal the model.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/attributeMetadata.property.integration.test.ts
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { freeFormType } from "@onden/markdown";
import { q, pool } from "../../db.js";
import { apiOnError } from "../../httpError.js";
import nodesRouter from "../../routes/nodes.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { checkAsync } from "../helpers/propsConfig.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));
let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);

type Type = "text" | "number" | "date" | "bool";
type Write = { value: string; value_type?: Type; is_inheritable?: boolean };

async function put(noteId: string, key: string, body: Write): Promise<Record<string, any>> {
  const res = await app.request(`/api/nodes/${noteId}/attributes/${key}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

async function world(): Promise<{ noteId: string }> {
  WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Attr properties', $1) RETURNING id::text`,
    [`attr-properties-${randomUUID()}`])).rows[0]!.id;
  currentActor = await persistActor(WS, { id: "ap-owner", name: "Owner", role: "admin", type: "human" });
  const res = await app.request("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "n", markdown: "x" }) });
  return { noteId: ((await res.json()) as { id: string }).id };
}

/** The model's next state for one write. */
function expected(prev: { type: Type; inh: boolean } | null, w: Write): { type: Type; inh: boolean } {
  const fits = (t: Type) => t === "text" || freeFormType(w.value) === t;
  const hint = w.value_type ?? prev?.type;
  return { type: hint && fits(hint) ? hint : freeFormType(w.value) as Type, inh: w.is_inheritable ?? prev?.inh ?? false };
}

async function stored(noteId: string, key: string) {
  return (await q<{ value_type: string; is_inheritable: boolean; value: string }>(
    `SELECT value, value_type, is_inheritable FROM node_attributes WHERE node_id = $1 AND key = $2`, [noteId, key])).rows[0]!;
}

async function apply(noteId: string, key: string, writes: Write[]): Promise<void> {
  let prev: { type: Type; inh: boolean } | null = null;
  for (const w of writes) {
    const want = expected(prev, w);
    const answer = await put(noteId, key, w);
    const row = await stored(noteId, key);
    const where = `after ${JSON.stringify(w)}`;
    expect(row.is_inheritable, `${where}: stored flag`).toBe(want.inh);
    expect(row.value_type, `${where}: stored type`).toBe(want.type);
    expect(answer.is_inheritable, `${where}: answered flag`).toBe(want.inh);
    prev = want;
  }
}

const value = fc.oneof(fc.integer({ min: -50, max: 50 }).map(String), fc.constantFrom("2026-01-02", "true", "word", ""));
const write: fc.Arbitrary<Write> = fc.record({
  value,
  value_type: fc.option(fc.constantFrom<Type>("text", "number", "date", "bool"), { nil: undefined }),
  is_inheritable: fc.option(fc.boolean(), { nil: undefined }),
}, { requiredKeys: ["value"] });

beforeAll(() => { if (isTestDb) registerShippedModules(); });
afterAll(async () => { if (isTestDb) await pool.end(); });

describe.skipIf(!isTestDb)("attribute writes keep the row's own flag and type", () => {
  it("random write sequences on one free-form key", async () => {
    await checkAsync(fc.asyncProperty(fc.array(write, { minLength: 1, maxLength: 8 }), async (writes) => {
      const { noteId } = await world();
      await apply(noteId, "priority", writes);
    }), 25);
  }, 300_000);

  it("a value edit with no flag keeps \"shares to children\" (M1, kanban drag / tag card)", async () => {
    const { noteId } = await world();
    await apply(noteId, "status", [{ value: "open", is_inheritable: true }, { value: "done" }]);
    expect((await stored(noteId, "status")).is_inheritable).toBe(true);
  });

  it("a value edit with no type keeps a number a number (M1)", async () => {
    const { noteId } = await world();
    await apply(noteId, "priority", [{ value: "3", value_type: "number" }, { value: "4" }]);
    expect((await stored(noteId, "priority")).value_type).toBe("number");
  });
});

