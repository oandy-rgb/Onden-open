// One set of rules for every move (depth audit D102, nodeTree.assertReparent).
// Undoing a move used to check only the cycle and read access, so the three
// inputs below slipped past rules a PATCH enforces:
//   • undo a move back under #書 after #小說 got its own `author` field — the
//     field clash D93 forbids;
//   • undo after a new same-name sibling took the name — the unique index
//     answered 23505 → 500;
//   • undo putting a note back under a tag (T12 keeps the trees apart).
// Each is now refused as 409 state_conflict with the rule's code as `reason`,
// and nothing moves. A plain undo still puts the node back.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";

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
function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

describe.skipIf(!isTestDb)("undoing a move follows every move's rules (D102)", () => {
  const stamp = Date.now();
  let WS = "";

  const tagPath = async (path: string): Promise<string> => {
    const res = await req("/api/tags/resolve-path", { method: "POST", json: { path } });
    expect(res.status).toBeLessThan(300);
    return ((await res.json()) as { leaf_id: string }).leaf_id;
  };
  const parentOf = async (id: string) =>
    (await q<{ parent_id: string | null }>(`SELECT parent_id::text AS parent_id FROM content_nodes WHERE id = $1`, [id])).rows[0]!.parent_id;
  /** Move `id` to the root through PATCH; returns the move's event id. */
  const moveToRoot = async (id: string): Promise<string> => {
    expect((await req(`/api/nodes/${id}`, { method: "PATCH", json: { parent_id: null } })).status).toBe(200);
    expect(await parentOf(id)).toBeNull();
    return (await q<{ id: string }>(
      `SELECT id::text FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND event_type = 'NODE_UPDATED'
          AND tx_meta->'prev_field_values' ? 'parent_id' ORDER BY domain_events.id DESC LIMIT 1`, [WS, id])).rows[0]!.id;
  };
  const undo = (eventId: string) => req(`/api/events/${eventId}/restore`, { method: "POST", json: {} });

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
  });

  it("a plain undo of a tag move puts it back under its parent", async () => {
    const parent = await tagPath(`甲-${stamp}`);
    const child = await tagPath(`甲-${stamp}/乙-${stamp}`);
    const moved = await moveToRoot(child);
    expect((await undo(moved)).status).toBe(200);
    expect(await parentOf(child)).toBe(parent);
  });

  it("undo refuses the field clash a PATCH refuses: #小說 got its own `author` after leaving #書", async () => {
    const book = await req("/api/tags/import", { method: "POST", json: { name: `書R-${stamp}`, fields: [{ name: "author", type: "text" }] } });
    expect(book.status).toBe(201);
    const bookId = ((await book.json()) as { id: string }).id;
    const novel = await tagPath(`書R-${stamp}/小說R-${stamp}`);
    const moved = await moveToRoot(novel);
    // At the root nothing gives #小說 an `author`: its own is fine.
    expect((await req(`/api/tags/${novel}/schema`, { method: "PATCH", json: { fields: [{ name: "author", type: "text" }] } })).status).toBe(200);
    // A PATCH back under #書 is refused...
    expect((await req(`/api/nodes/${novel}`, { method: "PATCH", json: { parent_id: bookId } })).status).toBe(409);
    // ...and so is the undo, which used to make the clash.
    const res = await undo(moved);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "state_conflict", reason: "field_name_inherited" });
    expect(await parentOf(novel)).toBeNull();
  });

  it("undo answers 409 tag_name_conflict (not 500) when a new same-name sibling took the name", async () => {
    const parent = await tagPath(`丙-${stamp}`);
    const first = await tagPath(`丙-${stamp}/同名-${stamp}`);
    const moved = await moveToRoot(first);
    const second = await tagPath(`丙-${stamp}/同名-${stamp}`);
    expect(second).not.toBe(first);
    expect(await parentOf(second)).toBe(parent);
    const res = await undo(moved);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "state_conflict", reason: "tag_name_conflict" });
    expect(await parentOf(first)).toBeNull();
  });

  it("undo never puts a note back under a tag", async () => {
    const tag = await tagPath(`丁-${stamp}`);
    const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    // A note filed under a tag before T12 (the rows a move may leave, never make).
    const note = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, space_id, source_type, node_type, title, slug, markdown, parent_id)
       VALUES ($1, $2, 'manual', 'content', $3, $4, 'x', $5) RETURNING id::text`,
      [WS, space, `mixed ${stamp}`, `mixed-${stamp}`, tag])).rows[0]!.id;
    const moved = await moveToRoot(note);
    const res = await undo(moved);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "state_conflict", reason: "parent_kind_mismatch" });
    expect(await parentOf(note)).toBeNull();
  });

  it("merging still moves #source's child tags under #target, and refuses a same-name child", async () => {
    const src = await tagPath(`源-${stamp}`);
    const tgt = await tagPath(`標-${stamp}`);
    const kid = await tagPath(`源-${stamp}/子-${stamp}`);
    expect((await req(`/api/tags/${src}/merge`, { method: "POST", json: { target_id: tgt } })).status).toBe(200);
    expect(await parentOf(kid)).toBe(tgt);

    const src2 = await tagPath(`源二-${stamp}`);
    await tagPath(`源二-${stamp}/重-${stamp}`);
    await tagPath(`標-${stamp}/重-${stamp}`);
    const res = await req(`/api/tags/${src2}/merge`, { method: "POST", json: { target_id: tgt } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("sub_tag_name_conflict");
  });
});
