import { persistActor } from "./helpers/persistActor.js";
// MB3 (2026-07-04 blindspot sweep): two slugify implementations disagreed —
// the tag-node slug was built by an ASCII-only SQL regexp, so every pure-CJK
// tag name collapsed to 'tag--' and the SECOND Chinese tag hit the
// (workspace,slug) partial unique index → 23505 → 500 (the race-catch looks
// up by (parent,title), finds no winner, rethrows). Chinese dogfood hit this
// almost immediately. All tag-creation paths now derive the slug in TS via
// uniqueTagSlug (Unicode-preserving slugify + unique suffix) — which also
// fixes same-name segments under different parents colliding on 'tag-<name>'.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import tagsRouter from "../routes/tags.js";
import type { ActorCtx } from "../types.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/tags", tagsRouter);

const admin: ActorCtx = { id: "cjk-admin", name: "Admin", role: "admin", type: "human" };

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe.skipIf(!isTestDb)("CJK tag slugs (MB3)", () => {
  const stamp = Date.now();

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    Object.assign(admin, await persistActor(await getWorkspaceId(), admin));
    currentActor = admin;
  });

  it("a SECOND pure-CJK tag via resolve-path succeeds (used to 500 on 'tag--' collision)", async () => {
    const r1 = await post("/api/tags/resolve-path", { path: `課程甲${stamp}` });
    expect(r1.status).toBe(200);
    const r2 = await post("/api/tags/resolve-path", { path: `數學乙${stamp}` });
    expect(r2.status, "second pure-CJK tag must not 500").toBe(200);
    const { leaf_id: id1 } = (await r1.json()) as { leaf_id: string };
    const { leaf_id: id2 } = (await r2.json()) as { leaf_id: string };
    expect(id1).not.toBe(id2);

    // Slugs are distinct and carry the Unicode name, not a collapsed 'tag--'.
    const rows = await q<{ id: string; slug: string }>(
      `SELECT id, slug FROM content_nodes WHERE id = ANY($1::uuid[])`, [[id1, id2]]);
    const slugs = rows.rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(2);
    expect(slugs.every((s) => s.startsWith("tag-") && s !== "tag--")).toBe(true);
  });

  it("same-name segments under DIFFERENT parents no longer collide on 'tag-<name>'", async () => {
    const a = await post("/api/tags/resolve-path", { path: `proj${stamp}/notes` });
    expect(a.status).toBe(200);
    const b = await post("/api/tags/resolve-path", { path: `arch${stamp}/notes` });
    expect(b.status, "second 'notes' segment under a different parent must not 500").toBe(200);
    const { leaf_id: la } = (await a.json()) as { leaf_id: string };
    const { leaf_id: lb } = (await b.json()) as { leaf_id: string };
    expect(la).not.toBe(lb);
  });

  it("a pure-CJK tag create succeeds twice", async () => {
    const c1 = await post("/api/tags", { name: `中文集甲${stamp}` });
    expect(c1.status).toBe(201);
    const c2 = await post("/api/tags", { name: `中文集乙${stamp}` });
    expect(c2.status).toBe(201);
  });
});
