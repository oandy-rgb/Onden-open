// Module library (services/workspaceModules.ts, docs/architecture/module-library.md).
//
//   • Built-in functions are on by default: a fresh workspace has every
//     module on without importing anything, except the confirm-once modules
//     (semantic search, RSS, website), which wait for the owner's one yes.
//   • Turning on / off are principal-admin decisions with MODULE_IMPORTED /
//     MODULE_REMOVED events; repeating one is a no-op without an event.
//   • An explicitly turned-off module stays off; a confirm-once module's yes
//     is stored once and never asked again.
//   • Migration 133 turns on what the owner never chose about, keeps what the
//     event log says they removed, and counts earlier imports as the yes.
//   • The first library run counts a confirm-once module in use as agreed.
//   • RSS background fetching pauses while RSS is off.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { backfillModuleImports } from "../modules/index.js";
import { isConfirmOnceModule, libraryModuleIds, setModuleImported, workspaceModules, workspaceWireRow, ModuleLibraryError } from "../services/workspaceModules.js";
import { enqueueDueRssFetches } from "../modules/rss/fetch.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// A workspace of the file's own: the tests rewrite its module list freely,
// which on the shared 'default' workspace would leak into every later file.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

describe.skipIf(!isTestDb)("module library (DB)", () => {
  let admin: ActorCtx;
  let editor: ActorCtx;
  let sourceId = "";

  const confirmOnce = () => libraryModuleIds().filter(isConfirmOnceModule);
  const events = async (type: string) => (await q<{ payload: { module?: string } }>(
    `SELECT payload FROM domain_events WHERE workspace_id = $1 AND event_type = $2 ORDER BY id DESC LIMIT 5`, [WS, type],
  )).rows.map((r) => r.payload.module);
  const eventCount = async () => Number((await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1 AND event_type IN ('MODULE_IMPORTED', 'MODULE_REMOVED')`, [WS])).rows[0]!.n);
  const state = async () => (await q<{ modules_off: string[]; modules_confirmed: string[] | null }>(
    `SELECT modules_off, modules_confirmed FROM workspaces WHERE id = $1`, [WS])).rows[0]!;

  beforeAll(async () => {
    registerShippedModules();
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Module library', $1) RETURNING id::text`,
      [`module-library-${randomUUID()}`])).rows[0]!.id;
    admin = await persistActor(WS, { id: "", name: "Admin", type: "human", role: "admin" });
    editor = await persistActor(WS, { id: "", name: "Editor", type: "human", role: "editor" });

    // A due RSS subscription (never fetched) for the background gate.
    sourceId = (await seedQ<{ id: string }>(
      `INSERT INTO rss_subscriptions (workspace_id, space_id, title, url)
       SELECT $1, s.id, 'Library feed', 'http://feed.test/library.xml' FROM spaces s
        WHERE s.workspace_id = $1 AND s.deleted_at IS NULL ORDER BY s.is_default DESC, s.created_at LIMIT 1 RETURNING id`, [WS],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await q(`DELETE FROM outbox WHERE dedup_key = $1`, [`rss_fetch:${sourceId}`]);
    await seedQ(`DELETE FROM rss_subscriptions WHERE id = $1`, [sourceId]);
  });

  it("a fresh workspace has every module on without importing, except the four that wait for a yes", async () => {
    const fresh = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Fresh', $1) RETURNING id::text`,
      [`module-fresh-${randomUUID()}`])).rows[0]!.id;
    const on = await workspaceModules(fresh);
    expect(confirmOnce().sort()).toEqual(["ai", "rss", "semantic", "website"]);
    // Skills need ai (library.requires), so they wait for its yes too.
    expect(on).toEqual(libraryModuleIds().filter((id) => !confirmOnce().includes(id) && id !== "skills"));
    // Everything the library ships, whether or not it has been used.
    for (const id of ["calendar", "canvas", "gallery", "kanban", "table", "review", "slides", "daily"]) {
      expect(on).toContain(id);
    }
    expect(on).not.toContain("skills");
    // The wire row says what is on and what still waits for a yes.
    const wire = workspaceWireRow((await q(`SELECT id, name, modules_off, modules_confirmed FROM workspaces WHERE id = $1`, [fresh])).rows[0]!);
    expect(wire.modules).toEqual(on);
    expect(wire.modules_to_confirm.sort()).toEqual(["ai", "rss", "semantic", "website"]);
    expect(wire).not.toHaveProperty("modules_off");
  });

  it("turning a module off keeps it off; turning it on again brings it back; repeating is a no-op without an event", async () => {
    await setModulesOn(WS, null);
    const before = await eventCount();
    const off = await setModuleImported({ actor: admin, workspaceId: WS, module: "review", imported: false });
    expect(off.modules).toEqual(libraryModuleIds().filter((id) => id !== "review"));
    expect(await workspaceModules(WS)).toEqual(off.modules);
    expect(await events("MODULE_REMOVED")).toContain("review");
    await setModuleImported({ actor: admin, workspaceId: WS, module: "review", imported: false });
    expect(await eventCount() - before).toBe(1);
    // A backfill never turns it back on.
    await backfillModuleImports({ workspaceId: WS });
    expect(await workspaceModules(WS)).not.toContain("review");
    expect((await setModuleImported({ actor: admin, workspaceId: WS, module: "review", imported: true })).modules).toContain("review");
    await setModuleImported({ actor: admin, workspaceId: WS, module: "review", imported: true });
    expect(await eventCount() - before).toBe(2);
    expect((await state()).modules_off).toEqual([]);
  });

  it("a confirm-once module is on only after the owner's yes, and the yes is never asked again", async () => {
    await q(`UPDATE workspaces SET modules_off = '[]'::jsonb, modules_confirmed = '[]'::jsonb WHERE id = $1`, [WS]);
    for (const id of confirmOnce()) expect(await workspaceModules(WS)).not.toContain(id);
    const yes = await setModuleImported({ actor: admin, workspaceId: WS, module: "rss", imported: true });
    expect(yes.modules).toContain("rss");
    expect(yes.modules_to_confirm.sort()).toEqual(["ai", "semantic", "website"]);
    // Off and on again: no second yes needed.
    const off = await setModuleImported({ actor: admin, workspaceId: WS, module: "rss", imported: false });
    expect(off.modules).not.toContain("rss");
    expect(off.modules_to_confirm).not.toContain("rss");
    expect((await state()).modules_confirmed).toContain("rss");
    expect((await setModuleImported({ actor: admin, workspaceId: WS, module: "rss", imported: true })).modules).toContain("rss");
  });

  it("only an admin decides; an unknown module is refused", async () => {
    await expect(setModuleImported({ actor: editor, workspaceId: WS, module: "review", imported: true })).rejects.toMatchObject({ name: "AuthorityError" });
    await expect(setModuleImported({ actor: admin, workspaceId: WS, module: "nope", imported: true })).rejects.toBeInstanceOf(ModuleLibraryError);
  });

  it("the first library run counts a confirm-once module in use as agreed, and leaves a recorded answer alone", async () => {
    await q(`UPDATE workspaces SET modules_off = '[]'::jsonb, modules_confirmed = NULL WHERE id = $1`, [WS]);
    await backfillModuleImports({ workspaceId: WS });
    // The subscription above puts RSS in use; nothing else asked for a yes.
    expect((await state()).modules_confirmed).toEqual(["rss"]);
    expect(await workspaceModules(WS)).toContain("rss");
    expect(await workspaceModules(WS)).not.toContain("semantic");
    await q(`UPDATE workspaces SET modules_confirmed = '[]'::jsonb WHERE id = $1`, [WS]);
    await backfillModuleImports({ workspaceId: WS });
    expect((await state()).modules_confirmed).toEqual([]);
  });

  it("migration 133: never-chosen modules turn on, removed ones stay off, earlier imports count as the yes", async () => {
    const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations/133_modules_default_on.sql"), "utf8");
    const old = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug, modules) VALUES ('Old list', $1, '["rss","review"]'::jsonb) RETURNING id::text`,
      [`module-old-${randomUUID()}`])).rows[0]!.id;
    const preLibrary = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug, modules) VALUES ('Pre library', $1, NULL) RETURNING id::text`,
      [`module-pre-${randomUUID()}`])).rows[0]!.id;
    const event = (type: string, module: string, at: number) => q(
      `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, created_at)
       VALUES ($1, 'system', 'migration-test', $2, 'workspace', $5::text, $3::jsonb, now() + ($4 || ' seconds')::interval)`,
      [old, type, JSON.stringify({ module }), String(at), old]); // $1 is a uuid; the text target_id gets its own parameter
    // Calendar was removed, kanban removed then imported again, website imported and later removed.
    await event("MODULE_REMOVED", "calendar", 1);
    await event("MODULE_REMOVED", "kanban", 2);
    await event("MODULE_IMPORTED", "kanban", 3);
    await event("MODULE_IMPORTED", "website", 4);
    await event("MODULE_REMOVED", "website", 5);
    // The column keeps the pre-133 decisions of the old workspaces: reset what the migration fills.
    await q(`UPDATE workspaces SET modules_off = '[]'::jsonb, modules_confirmed = NULL WHERE id = ANY($1::uuid[])`, [[old, preLibrary]]);
    await q(sql);
    await q(sql); // repeatable
    const row = async (id: string) => (await q<{ modules_off: string[]; modules_confirmed: string[] | null }>(
      `SELECT modules_off, modules_confirmed FROM workspaces WHERE id = $1`, [id])).rows[0]!;
    expect((await row(old)).modules_off).toEqual(["calendar", "website"]);
    // rss was in the list, website was imported once: both already said yes; semantic never did.
    expect((await row(old)).modules_confirmed).toEqual(["rss", "website"]);
    // Never chose (gallery, table…) is simply not in the off list.
    expect((await row(old)).modules_off).not.toContain("table");
    // A pre-library workspace waits for the boot backfill.
    expect(await row(preLibrary)).toEqual({ modules_off: [], modules_confirmed: null });
  });

  // modules/rss/fetch.ts enqueueDueRssFetches gates on the module library
  // (modules_off / modules_confirmed), like every other reader.
  it("RSS background fetching pauses while RSS is off", async () => {
    const pending = async () => (await q(`SELECT 1 FROM outbox WHERE dedup_key = $1 AND status = 'pending'`, [`rss_fetch:${sourceId}`])).rowCount;
    await q(`DELETE FROM outbox WHERE dedup_key = $1`, [`rss_fetch:${sourceId}`]);
    await setModulesOn(WS, ["review"]);
    await enqueueDueRssFetches();
    expect(await pending()).toBe(0);
    await setModulesOn(WS, ["rss"]);
    await enqueueDueRssFetches();
    expect(await pending()).toBe(1);
  });
});
