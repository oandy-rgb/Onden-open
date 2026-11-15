// Slug uniqueness: migration 064 moved the guarantee into the database (a
// partial unique index over live rows) because uniqueSlug() is read-then-pick
// and racy under concurrent creates. These tests pin the three halves of the
// fix against a real Postgres:
//   1. the index exists and rejects a duplicate live slug in one space (migration 099);
//   2. isSlugConflict() recognizes exactly that rejection (real error shape,
//      not a hand-built one);
//   3. retryOnSlugConflict() turns "lost the race" into a re-run that picks
//      the next free suffix — the route-visible behavior.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";
import { uniqueSlug, isSlugConflict, retryOnSlugConflict } from "../services/nodes.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

async function insertNode(ws: string, title: string, slug: string): Promise<string> {
  const id = randomUUID();
  await seedQ(
    `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, hidden, sort_order)
     VALUES ($1, $2, 'manual', 'content', $3, $4, '', false, 0)`,
    [id, ws, title, slug],
  );
  return id;
}

describe.skipIf(!isTestDb)("slug uniqueness — DB constraint + conflict retry (migration 064)", () => {
  let WS = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
  });

  it("the partial unique index exists per space (workspace_id, space, slug) WHERE deleted_at IS NULL", async () => {
    const r = await q<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'content_nodes_space_slug_uq'`,
    );
    expect(r.rows[0]?.indexdef).toMatch(/UNIQUE/);
    expect(r.rows[0]?.indexdef).toMatch(/deleted_at IS NULL/);
  });

  it("a duplicate live slug is rejected with 23505, and isSlugConflict recognizes the REAL error shape", async () => {
    const slug = `slug-race-${Date.now()}`;
    await insertNode(WS, "winner", slug);
    let caught: unknown = null;
    try {
      await insertNode(WS, "loser", slug);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect((caught as { code?: string }).code).toBe("23505");
    expect(isSlugConflict(caught)).toBe(true);
  });

  it("a soft-deleted row does NOT block its slug (partial index covers live rows only)", async () => {
    const slug = `slug-dead-${Date.now()}`;
    const deadId = await insertNode(WS, "dead", slug);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [deadId]);
    await expect(insertNode(WS, "alive", slug)).resolves.toBeTruthy();
  });

  it("isSlugConflict is narrow: other unique violations / other errors don't match", () => {
    expect(isSlugConflict({ code: "23505", constraint: "content_nodes_pkey" })).toBe(false);
    expect(isSlugConflict(new Error("boom"))).toBe(false);
    expect(isSlugConflict(null)).toBe(false);
  });

  it("retryOnSlugConflict re-runs the create with a recomputed slug (the simulated race)", async () => {
    const base = `slug-retry-${Date.now()}`;
    await insertNode(WS, "occupant", base);
    // Simulate losing the race: the first attempt insists on the STALE slug
    // (as if another request committed it between read and insert); the retry
    // calls uniqueSlug like the real create paths do and lands on -2.
    let attempt = 0;
    const id = await retryOnSlugConflict(async () => {
      attempt++;
      const slug = attempt === 1 ? base : await uniqueSlug(WS, base);
      return insertNode(WS, "racer", slug);
    });
    expect(attempt).toBe(2);
    const row = await q<{ slug: string }>(`SELECT slug FROM content_nodes WHERE id = $1`, [id]);
    expect(row.rows[0]!.slug).toBe(`${base}-2`);
  });

  it("retryOnSlugConflict rethrows non-slug errors immediately (no blind retry loop)", async () => {
    let attempts = 0;
    await expect(
      retryOnSlugConflict(async () => {
        attempts++;
        throw new Error("unrelated failure");
      }),
    ).rejects.toThrow("unrelated failure");
    expect(attempts).toBe(1);
  });

  it("retryOnSlugConflict gives up after its retry budget instead of spinning", async () => {
    let attempts = 0;
    await expect(
      retryOnSlugConflict(async () => {
        attempts++;
        throw Object.assign(new Error("dup"), { code: "23505", constraint: "content_nodes_space_slug_uq" });
      }),
    ).rejects.toThrow("dup");
    expect(attempts).toBe(3); // initial + 2 retries
  });
});
