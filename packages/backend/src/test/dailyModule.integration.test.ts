// Daily notes (日記) as a library module (src/modules/daily). A new
// workspace starts without it; a workspace that already records a module list
// gets it from migration 112, and a pre-library workspace (modules NULL) gets
// it from the boot backfill when it has day notes. The day lens is a read, so
// it keeps answering while the module is removed (its data is kept).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import { MODULES, backfillModuleImports, mountModules, registerModuleEffects } from "../modules/index.js";
import { dailyModule, hasDayNotes } from "../modules/daily/index.js";
import { workspaceModules } from "../services/workspaceModules.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";

// The module switch is a workspace setting: flip it in a workspace of this
// file's own, never in the shared default one (the day route reads it here).
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("daily notes module (DB)", () => {
  const stamp = Date.now();
  const created: string[] = [];
  let currentActor: ActorCtx | null = null;
  const owner: ActorCtx = { id: "daily-owner", name: "Owner", role: "admin", type: "human" };

  const newWorkspace = async (label: string, modules: string[] | null = null) => {
    const id = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Daily ${label}`, `daily-${label}-${stamp}`],
    )).rows[0]!.id;
    created.push(id);
    if (modules !== null) await setModulesOn(id, modules);
    return id;
  };
  const addNote = (workspaceId: string, title: string, extra: { hidden?: boolean; deleted?: boolean } = {}) =>
    seedQ(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden, deleted_at)
       VALUES ($1, 'manual', 'content', $2, $3, '', $4, $5)`,
      [workspaceId, title, `daily-${title}-${stamp}-${Math.random().toString(36).slice(2)}`, extra.hidden ?? false, extra.deleted ? new Date() : null]);

  beforeAll(async () => {
    registerModuleEffects(dailyModule);
    WS = await newWorkspace("main", ["canvas", "daily"]);
    Object.assign(owner, await persistActor(WS, owner));
    currentActor = owner;
  });
  afterAll(async () => {
    for (const id of created) {
      await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [id]);
      await q(`DELETE FROM workspaces WHERE id = $1`, [id]);
    }
  });

  it("is a library module, on by default", async () => {
    const mod = MODULES.find((m) => m.id === "daily");
    expect(mod).toBe(dailyModule);
    expect(mod!.library).toBeDefined();
    expect(mod!.library!.confirmOnce).toBeFalsy();
    // A new workspace has it on without importing; no day note is needed.
    const fresh = await newWorkspace("fresh");
    expect(await hasDayNotes(fresh)).toBe(false);
    await backfillModuleImports({ workspaceId: fresh });
    expect(await workspaceModules(fresh)).toContain("daily");
  });

  it("migration 112 adds daily to every recorded list, once, and leaves NULL alone", async () => {
    const sql = readFileSync(fileURLToPath(new URL("../../db/migrations/112_daily_module.sql", import.meta.url)), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ids = (await client.query<{ id: string }>(
        `INSERT INTO workspaces (name, slug, modules) VALUES
           ('Daily a', $1, '["rss"]'::jsonb), ('Daily b', $2, '["daily"]'::jsonb), ('Daily c', $3, NULL), ('Daily d', $4, '[]'::jsonb)
         RETURNING id`, [`dm-a-${stamp}`, `dm-b-${stamp}`, `dm-c-${stamp}`, `dm-d-${stamp}`])).rows.map((r) => r.id);
      await client.query(sql);
      await client.query(sql); // repeatable
      const rows = (await client.query<{ id: string; modules: string[] | null }>(
        `SELECT id, modules FROM workspaces WHERE id = ANY($1::uuid[])`, [ids])).rows;
      const byId = new Map(rows.map((r) => [r.id, r.modules]));
      expect(byId.get(ids[0]!)).toEqual(["rss", "daily"]);
      expect(byId.get(ids[1]!)).toEqual(["daily"]);
      expect(byId.get(ids[2]!)).toBeNull();
      expect(byId.get(ids[3]!)).toEqual(["daily"]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("the day lens keeps answering while the module is removed (reads stay open)", async () => {
    const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
    app.onError(apiOnError);
    app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
    mountModules(app, [dailyModule]);
    await setModulesOn(WS, ["canvas"]);
    const off = await app.request("/api/day/2026-10-18/lens");
    expect(off.status).toBe(200);
    expect(await off.json()).toHaveProperty("buckets.created");
    await setModulesOn(WS, ["canvas","daily"]);
    expect((await app.request("/api/day/2026-10-18/lens")).status).toBe(200);
  });
});
