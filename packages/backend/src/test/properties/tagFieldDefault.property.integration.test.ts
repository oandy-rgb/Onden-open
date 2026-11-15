// A schema field's default through PATCH /api/tags/:id/schema (scan 06 S4), random field type / options / default.
// The default is seeded as the value of every note that gets the tag, so the write is accepted exactly when the
// field would accept that value: text takes anything, a number field a plain number, a select one of its options;
// an empty default is "no default". A refused write is a 400 and leaves the stored fields as they were.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/tagFieldDefault.property.integration.test.ts
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../../httpError.js";
import { q, pool } from "../../db.js";
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
app.route("/api/tags", tagsRouter);

const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const storedFields = async (id: string) => (await q<{ f: unknown }>(`SELECT tag_schema->'fields' AS f FROM content_nodes WHERE id = $1`, [id])).rows[0]!.f;

beforeAll(async () => {
  if (!isTestDb) return;
  WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Field defaults', $1) RETURNING id::text`, [`field-defaults-${randomUUID()}`])).rows[0]!.id;
  owner = await persistActor(WS, { id: "fd-owner", name: "Owner", role: "admin", type: "human" });
});
afterAll(async () => { if (isTestDb) await pool.end(); });

type Field = { name: string; type: "text" | "number" | "select"; options?: string[]; default?: string };
const OPTIONS = ["todo", "doing", "done"];
const field = fc.record({
  type: fc.constantFrom<Field["type"]>("text", "number", "select"),
  default: fc.constantFrom("", "doing", "gone", "3", "-2.5", "1e3", "abc"),
});

function accepted(type: Field["type"], value: string): boolean {
  if (value === "") return true;
  if (type === "number") return /^-?\d+(\.\d+)?$/.test(value);
  if (type === "select") return OPTIONS.includes(value);
  return true;
}

describe.skipIf(!isTestDb)("a field's default must be a value the field accepts", () => {
  async function freshTag(): Promise<string> {
    const res = await send("POST", "/api/tags", { name: `t${randomUUID().slice(0, 8)}` });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }
  async function writeField(id: string, f: Field): Promise<number> {
    return (await send("PATCH", `/api/tags/${id}/schema`, { fields: [f] })).status;
  }

  it("random type / default", async () => {
    await checkAsync(fc.asyncProperty(field, async ({ type, default: seeded }) => {
      const id = await freshTag();
      const before = await storedFields(id);
      const f: Field = { name: "status", type, ...(type === "select" ? { options: OPTIONS } : {}), ...(seeded === "" ? {} : { default: seeded }) };
      const status = await writeField(id, f);
      expect(status, JSON.stringify(f)).toBe(accepted(type, seeded) ? 200 : 400);
      if (status !== 200) expect(await storedFields(id)).toEqual(before);
    }), 30);
  }, 300_000);

  it("S4: removing the option a default points at is refused while the default stays", async () => {
    const id = await freshTag();
    expect(await writeField(id, { name: "status", type: "select", options: OPTIONS, default: "doing" })).toBe(200);
    expect(await writeField(id, { name: "status", type: "select", options: ["todo", "done"], default: "doing" })).toBe(400);
    expect(await writeField(id, { name: "status", type: "select", options: ["todo", "done"] })).toBe(200);
  });

  it("S4: a number default of 1e3 is refused (the server's number rule does not take it)", async () => {
    const id = await freshTag();
    expect(await writeField(id, { name: "hours", type: "number", default: "1e3" })).toBe(400);
  });
});
