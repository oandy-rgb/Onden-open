// Migration 178: the retired 收工 preference rows are deleted, every other
// preference stays, and a second run changes nothing.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkspaceId, q } from "../db.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(resolve(here, "../../db/migrations/178_retire_shutdown_prefs.sql"), "utf8");

describe.skipIf(!isTestDatabase())("migration 178 — retire 收工 preferences (DB)", () => {
  let actorId = "";
  let workspaceId = "";
  beforeAll(async () => {
    await seedQ(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO NOTHING`);
    actorId = (await persistActor(workspaceId = await getWorkspaceId(), { id: "m178", name: "M178", role: "editor", type: "human" })).id;
  });
  afterAll(async () => {
    await seedQ("DELETE FROM actor_prefs WHERE actor_id = $1", [actorId]);
    await q("DELETE FROM space_members WHERE actor_id = $1", [actorId]);
    // The first human persisted on an ownerless workspace became its owner; an owner's row can't be deleted.
    const { rows } = await q<{ owner_actor_id: string | null }>("SELECT owner_actor_id::text FROM workspaces WHERE id = $1", [workspaceId]);
    if (rows[0]?.owner_actor_id === actorId) await setWorkspaceOwner(workspaceId, null);
    await q("DELETE FROM actors WHERE id = $1", [actorId]);
  });

  const keys = async () => (await q<{ key: string }>("SELECT key FROM actor_prefs WHERE actor_id = $1 ORDER BY key", [actorId])).rows.map((r) => r.key);

  it("deletes both keys, keeps the others, and can run again", async () => {
    for (const [key, value] of [
      ["journalShutdown", { date: "2026-10-26", done: 1, tomorrow: 0, dated: 0, dropped: 0 }],
      ["journalShutdowns", { "2026-10-26": { done: 1, tomorrow: 0, dated: 0, dropped: 0 } }],
      ["focusMinutes", 25],
      ["rssShowCounts", true],
    ] as const) {
      await seedQ("INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, $2, $3)", [actorId, key, JSON.stringify(value)]);
    }
    await seedQ(MIGRATION);
    expect(await keys()).toEqual(["focusMinutes", "rssShowCounts"]);
    await seedQ(MIGRATION);
    expect(await keys()).toEqual(["focusMinutes", "rssShowCounts"]);
  });
});
