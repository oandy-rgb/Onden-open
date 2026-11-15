// Migration 106: a keyless #subscription row that was flipped or trashed
// before migration 100 gets the reserved key, so its feeds are found again now
// that the RSS self-heal only repairs a keyed row (T5). One row per workspace,
// root only, only with members, never when some row already holds the key;
// re-running changes nothing.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";

const MIGRATION = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations/106_subscription_key_backfill.sql"), "utf8");

describe.skipIf(!isTestDatabase())("migration 106 — subscription key backfill (DB)", () => {
  const ws: Record<string, string> = {};
  const row: Record<string, string> = {};

  async function workspace(name: string) {
    ws[name] = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`,
      [name, `m106-${randomUUID()}`])).rows[0]!.id;
  }
  async function node(key: string, w: string, opts: {
    type?: string; title?: string; parent?: string; deleted?: boolean; reserved?: string; created?: string; members?: number;
  } = {}) {
    row[key] = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, deleted_at, reserved_key, created_at)
       VALUES ($1, 'manual', $2, $3, $4, '', $5, CASE WHEN $6 THEN now() END, $7, COALESCE($8::timestamptz, now())) RETURNING id`,
      [ws[w], opts.type ?? "class_tag", opts.title ?? "subscription", `m106-${randomUUID()}`,
        opts.parent ? row[opts.parent] : null, opts.deleted ?? false, opts.reserved ?? null, opts.created ?? null])).rows[0]!.id;
    for (let i = 0; i < (opts.members ?? 0); i++) {
      const member = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1, 'rss', 'content', 'feed', $2, '') RETURNING id`, [ws[w], `m106-${randomUUID()}`])).rows[0]!.id;
      await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [member, row[key]]);
    }
  }
  const keyOf = async (key: string) =>
    (await q<{ reserved_key: string | null }>(`SELECT reserved_key FROM content_nodes WHERE id = $1`, [row[key]])).rows[0]!.reserved_key;

  beforeAll(async () => {
    // live: a live keyless class_tag wins over a newer trashed one.
    await workspace("live");
    await node("liveTag", "live", { members: 1, created: "2026-01-01" });
    await node("liveTrashed", "live", { deleted: true, members: 1, created: "2026-02-01" });
    // broken: only a flipped and a trashed row — the more recent one.
    await workspace("broken");
    await node("flipped", "broken", { type: "content", members: 2, created: "2026-01-01" });
    await node("trashedNewer", "broken", { deleted: true, members: 1, created: "2026-03-01" });
    // ordinary: a member's nested #x/subscription with members, a root one
    // without members, a note titled subscription — none is the RSS tag.
    await workspace("ordinary");
    await node("x", "ordinary", { title: "x" });
    await node("nested", "ordinary", { parent: "x", deleted: true, members: 1 });
    await node("unused", "ordinary", { deleted: true });
    // keyed: a row already holds the key (even trashed) — nothing is displaced.
    await workspace("keyed");
    await node("keyedTrashed", "keyed", { deleted: true, reserved: "subscription", members: 1 });
    await node("keylessLive", "keyed", { members: 1 });
    await seedQ(MIGRATION);
  });

  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = ANY($1::uuid[])`, [Object.values(ws)]);
    await q(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [Object.values(ws)]);
  });

  it("keys one root row with members per workspace, preferring a live class_tag", async () => {
    expect(await keyOf("liveTag")).toBe("subscription");
    expect(await keyOf("liveTrashed")).toBeNull();
    expect(await keyOf("trashedNewer")).toBe("subscription");
    expect(await keyOf("flipped")).toBeNull();
  });

  it("never keys a nested, member-less or second row", async () => {
    expect(await keyOf("nested")).toBeNull();
    expect(await keyOf("unused")).toBeNull();
    expect(await keyOf("keylessLive")).toBeNull();
    expect(await keyOf("keyedTrashed")).toBe("subscription");
  });

  it("is idempotent", async () => {
    const before = await q(`SELECT id, reserved_key FROM content_nodes WHERE workspace_id = ANY($1::uuid[]) ORDER BY id`, [Object.values(ws)]);
    await seedQ(MIGRATION);
    const after = await q(`SELECT id, reserved_key FROM content_nodes WHERE workspace_id = ANY($1::uuid[]) ORDER BY id`, [Object.values(ws)]);
    expect(after.rows).toEqual(before.rows);
  });
});
