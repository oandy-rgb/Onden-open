// A create with a client-minted id that is already a note (D68: today's note
// has a deterministic id per person and date, so two devices send the same
// create). With the id as Idempotency-Key — what the client sends — the second
// create is the dedupe acknowledgement; once that key is gone, the same id is a
// known conflict (409 note_exists) the client resolves by opening the note,
// not a 500 its queue would retry forever.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import { withIdempotencyKey } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

let actor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.use("*", async (c, next) => {
  const key = c.req.header("idempotency-key");
  return key ? withIdempotencyKey(key, next) : next();
});
app.route("/api/nodes", nodeRouter);

const create = (body: unknown, key?: string) => app.request("/api/nodes", {
  method: "POST",
  headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
  body: JSON.stringify(body),
});
const count = async (id: string) =>
  (await q<{ n: string }>("SELECT count(*) AS n FROM content_nodes WHERE id = $1", [id])).rows[0]!.n;

describe.skipIf(!isTestDb)("creating a note whose id is taken", () => {
  let workspaceId: string;

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Test', 'default')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    )).rows[0]!.id;
    // Shorthand role "admin" = the workspace owner (helpers/persistActor.ts).
    actor = await persistActor(workspaceId, { id: "", name: "Owner", role: "admin", type: "human" });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("the same create twice (id = Idempotency-Key) converges on one note", async () => {
    const id = randomUUID();
    const first = await create({ id, title: "2026-10-17", markdown: "" }, id);
    expect(first.status).toBe(201);
    const second = await create({ id, title: "2026-10-17", markdown: "" }, id);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ deduped: true });
    expect(await count(id)).toBe("1");
  });

  it("an id that is already a note, under a new key, is 409 note_exists and changes nothing", async () => {
    const id = randomUUID();
    expect((await create({ id, title: "Kept", markdown: "first" }, id)).status).toBe(201);
    const again = await create({ id, title: "Other", markdown: "second" }, randomUUID());
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "note_exists" });
    const row = (await q<{ title: string; markdown: string }>("SELECT title, markdown FROM content_nodes WHERE id = $1", [id])).rows[0]!;
    expect(row).toMatchObject({ title: "Kept" });
    expect(row.markdown).toContain("first");
  });
});
