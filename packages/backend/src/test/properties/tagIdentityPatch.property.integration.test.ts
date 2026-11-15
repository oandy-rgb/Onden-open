// PATCH /api/tags/:id with random names and colors (scan 06 S7): the rename and colour rules equal the create rules.
// Invariant: the write is accepted exactly when the name is 1..TAG_NAME_MAX characters without "/" and the colour
// is #rrggbb (or null); a refused write is a 400 and leaves the tag as it was.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/tagIdentityPatch.property.integration.test.ts
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { TAG_NAME_MAX, isHexColor } from "@onden/markdown";
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

const patch = (id: string, body: unknown) => app.request(`/api/tags/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const row = async (id: string) => (await q<{ title: string; tag_color: string | null }>(`SELECT title, tag_color FROM content_nodes WHERE id = $1`, [id])).rows[0]!;

beforeAll(async () => {
  if (!isTestDb) return;
  WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Tag identity', $1) RETURNING id::text`, [`tag-identity-${randomUUID()}`])).rows[0]!.id;
  owner = await persistActor(WS, { id: "ti-owner", name: "Owner", role: "admin", type: "human" });
});
afterAll(async () => { if (isTestDb) await pool.end(); });

const name = fc.oneof(
  fc.integer({ min: 1, max: TAG_NAME_MAX + 60 }).map((n) => "n".repeat(n)),
  fc.constantFrom("ok", "a/b", "/", " "),
);
const color = fc.constantFrom<string | null>("#aabbcc", "#112233", null, "red", "", "url(x)", "#12");

describe.skipIf(!isTestDb)("PATCH /api/tags/:id: the identity rules equal the create rules", () => {
  async function freshTag(): Promise<string> {
    const res = await app.request("/api/tags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `t${randomUUID().slice(0, 8)}` }) });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it("random names and colours", async () => {
    await checkAsync(fc.asyncProperty(name, color, async (n, c) => {
      const id = await freshTag();
      const before = await row(id);
      const res = await patch(id, { name: n, color: c });
      const valid = n.length >= 1 && n.length <= TAG_NAME_MAX && n === n.trim() && !n.includes("/") && (c === null || isHexColor(c));
      if (valid) expect(res.status, `${JSON.stringify([n.length, c])}`).toBe(200);
      else {
        expect(res.status, `${JSON.stringify([n.length, c])}`).toBe(400);
        expect(await row(id)).toEqual(before);
      }
    }), 30);
  }, 300_000);

  it("S7: a 201-character name and a colour that is not #rrggbb are refused", async () => {
    const id = await freshTag();
    expect((await patch(id, { name: "n".repeat(TAG_NAME_MAX + 1) })).status).toBe(400);
    expect((await patch(id, { color: "url(javascript:x)" })).status).toBe(400);
  });
});
