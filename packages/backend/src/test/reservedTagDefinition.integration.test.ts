// T1: a reserved tag (#task, #page, #workspace-config) can be
// renamed but never merged — on either end — nor deleted. Agenda, RSS and site
// settings find it by reserved_key: a merged-away or trashed #task is re-minted
// and the old row can never come back (content_nodes_reserved_key_uq), and
// notes merged into #workspace-config would become config nodes.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { RESERVED_TAGS, adoptReservedTag, reservedTagId, type ReservedTagKey } from "../services/reservedTags.js";
import { reservedTagFixture } from "./helpers/reservedTag.js";
import { seedQ } from "./helpers/seedQ.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

const NATIVE = { origin: "http://localhost" };
async function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

// The tasks module's tag keeps the same protection (reservedTags.assertTagDefinitionChange).
type GuardedKey = ReservedTagKey | "task";
const KEYS = [...Object.values(RESERVED_TAGS), "task"] as GuardedKey[];

describe.skipIf(!isTestDb)("reserved tags refuse merge and delete (T1)", () => {
  const stamp = Date.now();
  let WS = "";
  const reserved = new Map<GuardedKey, string>();
  const plainTag = async (name: string): Promise<string> =>
    ((await (await req("/api/tags/import", { method: "POST", json: { name, fields: [] } })).json()) as { id: string }).id;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    await ensureConfigNode(WS); // mints #workspace-config the way bootstrap does
    for (const key of KEYS) {
      // The shared test workspace may already hold a keyless root tag of this
      // title from another suite; adopt it the way ensureReservedTag does
      // instead of colliding with it on the root-title index.
      let id = key === "task" ? await reservedTagFixture(WS, key) : await reservedTagId(WS, key) ?? await adoptReservedTag(WS, key);
      if (!id) {
        id = (await seedQ<{ id: string }>(
          `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, reserved_key)
           VALUES ($1, 'manual', 'class_tag', $2, $3, $2) RETURNING id`,
          [WS, key, `t1-${key}-${stamp}`],
        )).rows[0]!.id;
      }
      reserved.set(key, id);
    }
  });

  async function expectRefused(res: Response, key: string): Promise<void> {
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("reserved_tag");
    expect(body.detail).toContain(`#${key}`);
  }

  async function stillLive(id: string): Promise<boolean> {
    return (await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND deleted_at IS NULL`, [id])).rows.length === 1;
  }

  it.each(KEYS)("refuses merging an ordinary tag INTO #%s (preview and merge)", async (key) => {
    const target = reserved.get(key)!;
    const source = await plainTag(`t1Into${key.replace(/\W/g, "")}${stamp}`);
    await expectRefused(await req(`/api/tags/${source}/merge-preview?target=${target}`), key);
    await expectRefused(await req(`/api/tags/${source}/merge`, { method: "POST", json: { target_id: target } }), key);
    expect(await stillLive(source)).toBe(true);
  });

  it.each(KEYS)("refuses merging #%s AWAY into an ordinary tag", async (key) => {
    const source = reserved.get(key)!;
    const target = await plainTag(`t1From${key.replace(/\W/g, "")}${stamp}`);
    await expectRefused(await req(`/api/tags/${source}/merge-preview?target=${target}`), key);
    await expectRefused(await req(`/api/tags/${source}/merge`, { method: "POST", json: { target_id: target } }), key);
    expect(await stillLive(source)).toBe(true);
  });

  it("refuses merging one reserved tag into another", async () => {
    const res = await req(`/api/tags/${reserved.get("task")!}/merge`, { method: "POST", json: { target_id: reserved.get("page")! } });
    await expectRefused(res, "task");
  });

  it("refuses deleting #task", async () => {
    const task = reserved.get("task")!;
    // The delete-preview stays readable: the tag page also reads its field
    // usage counts from it. The page hides Delete by reserved_key instead.
    expect((await req(`/api/tags/${task}/delete-preview`)).status).toBe(200);
    await expectRefused(await req(`/api/nodes/${task}`, { method: "DELETE" }), "task");
    expect(await stillLive(task)).toBe(true);
    // Nothing committed: no NODE_DELETED for #task survived the rollback.
    const events = await q(`SELECT 1 FROM domain_events WHERE target_id = $1 AND event_type IN ('NODE_DELETED', 'COLLECTION_SCHEMA_DELETED')`, [task]);
    expect(events.rows).toHaveLength(0);
  });

  it("refuses deleting a parent tag whose subtree holds a reserved tag", async () => {
    const parent = await plainTag(`t1Parent${stamp}`);
    const sub = reserved.get("page")!;
    await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [sub, parent]);
    try {
      await expectRefused(await req(`/api/nodes/${parent}`, { method: "DELETE" }), "page");
      expect(await stillLive(parent)).toBe(true);
      expect(await stillLive(sub)).toBe(true);
    } finally {
      await seedQ(`UPDATE content_nodes SET parent_id = NULL WHERE id = $1`, [sub]);
    }
  });

  it("still merges and deletes ordinary tags", async () => {
    const source = await plainTag(`t1OkSrc${stamp}`);
    const target = await plainTag(`t1OkTgt${stamp}`);
    const merged = await req(`/api/tags/${source}/merge`, { method: "POST", json: { target_id: target } });
    expect(merged.status).toBe(200);
    expect(await stillLive(source)).toBe(false);
    expect((await req(`/api/tags/${target}/delete-preview`)).status).toBe(200);
    expect((await req(`/api/nodes/${target}`, { method: "DELETE" })).status).toBeLessThan(300);
    expect(await stillLive(target)).toBe(false);
  });
});
