// The export half of a stamped snapshot on ONE database, in a workspace of its own: it holds the rows the owner reads and their stamps
// (tombstones too), leaves out what the owner cannot read, refuses what is not done, and its digest is the digest of what is in the
// database. This is the part of the snapshot that needs no second database, so it runs on real Postgres as well as PGlite; the copy
// to an empty database is src/test/stampedSnapshot.integration.test.ts (PGlite only).
// realPostgresAlso: the pages are made by plain SQL (jsonb_build_object, keyset paging on the primary key, COLLATE "C", sha256) that
// both engines run; this is the check that Postgres gives the same answer.
// SAFETY: only runs against a *_test database; skips otherwise. It makes a workspace of its own and removes it.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { readStampedPages } from "../services/stampedSnapshot.js";
import { withActorReadSnapshot } from "../services/actorReadSnapshot.js";
import { snapshotScopeFor } from "../services/readPolicy.js";
import { compareDigests, computeSnapshotDigest, type StampedPage } from "../spine/snapshotSql.js";
import { SNAPSHOT_SPECS } from "../spine/snapshotTables.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("the export half of a stamped snapshot, on one database", () => {
  let ws = "";
  let owner!: ActorCtx;
  let friend!: ActorCtx;
  let secretNote = "";
  let root = "";
  const read = (actor: ActorCtx, pageBytes?: number) => {
    const pages: StampedPage[] = [];
    return readStampedPages(actor, ws, { since: null, layer: "rows", pageBytes }, async (page) => { pages.push(JSON.parse(JSON.stringify(page))); }).then((summary) => ({ pages, summary }));
  };

  beforeAll(async () => {
    ws = (await seedQ<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Snapshot export', $1) RETURNING id::text`, [`snap-${randomUUID().slice(0, 8)}`])).rows[0]!.id;
    owner = await persistActor(ws, { id: "", name: "Snapshot owner", role: "admin", type: "human" });
    friend = await persistActor(ws, { id: "", name: "Snapshot friend", role: "editor", type: "human" });
    const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
    const secretSpace = await makeSpace(ws, `secret ${randomUUID().slice(0, 6)}`, [{ id: friend.id, permission: "edit" }]);
    const note = (title: string, extra = "") => `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id${extra ? ", parent_id" : ""}) VALUES ($1, $2, 'manual', 'content', '${title}', $3, 'text of ${title}', $4${extra ? ", $5" : ""})`;
    root = randomUUID();
    const child = randomUUID();
    const gone = randomUUID();
    secretNote = randomUUID();
    await seedQ(note("Root"), [root, ws, `root-${root}`, space]);
    await seedQ(note("Child", "p"), [child, ws, `child-${child}`, space, root]);
    await seedQ(note("Gone"), [gone, ws, `gone-${gone}`, space]);
    await seedQ(note("Friend only"), [secretNote, ws, `secret-${secretNote}`, secretSpace]);
    const tag = randomUUID();
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, tag_schema) VALUES ($1, $2, 'manual', 'class_tag', 'a tag', $3, '{"rank": {"type": "number"}}'::jsonb)`, [tag, ws, `tag-${tag}`]);
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [root, tag]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, 'rank', '3', 'ui')`, [ws, child]);
    await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1, $2, $3, 'related', 'active', 'manual')`, [ws, root, child]);
    await seedQ(`INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, 'graph', 1.5, 2, $2)`, [root, ws]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_space_id, config) VALUES ($1, 'tasks', $2, '{"a": 1}'::jsonb)`, [ws, space]);
    // A note whose 「內容」 tab was removed: its record says hidden (a view of layout "content"), its text is the note's own.
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id, instance, config) VALUES ($1, 'content', $2, $3, $4::jsonb)`,
      [ws, root, randomUUID(), JSON.stringify({ name: "Content", filters: [], sorts: [], group_by: null, visible_fields: [], layout_config: { hidden: true }, pin_order: 1 })]);
    await seedQ(`UPDATE content_nodes SET title = 'Root (renamed)' WHERE id = $1`, [root]); // a field with a stamp of its own
    await seedQ(`DELETE FROM content_nodes WHERE id = $1`, [gone]); // a hard delete leaves a tombstone, not a row
    await seedQ(`INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, 'theme', '"dark"'::jsonb), ($2, 'theme', '"light"'::jsonb)`, [owner.id, friend.id]);
  }, 60_000);

  afterAll(async () => {
    await seedQ(`DELETE FROM sync_stamps WHERE workspace_id = $1`, [ws]);
    await seedQ(`DELETE FROM sync_clock WHERE workspace_id = $1`, [ws]);
    await deleteWorkspaceActors(ws);
    await seedQ(`DELETE FROM workspaces WHERE id = $1`, [ws]);
    await pool.end();
  });

  it("pages hold the rows the owner reads with their stamps, tombstones, and what points back at a later row", async () => {
    const { pages, summary } = await read(owner, 4_000);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((p) => p.page)).toEqual(pages.map((_, i) => i + 1));
    expect(new Set(pages.map((p) => p.cut)).size).toBe(1);
    expect(pages.every((p) => p.source === summary.source && p.workspaceId === ws && p.layer === "rows")).toBe(true);
    const items = pages.flatMap((p) => p.items);
    const notes = items.flatMap((i) => (i.kind === "row" && i.table === "content_nodes" ? [i] : []));
    expect(notes.map((n) => String(n.values.title)).sort()).toEqual(["Child", "Root (renamed)", "a tag"].sort());
    // the renamed note's title carries its own, later stamp; the row's own stamp is the older one
    const rootRow = notes.find((n) => n.values.id === root)!;
    const title = rootRow.stamps.find((s) => s.label === "content_nodes" && s.field === "title")!;
    const whole = rootRow.stamps.find((s) => s.label === "content_nodes" && s.field === "*")!;
    expect(title.seq).toBeGreaterThan(whole.seq);
    expect(items.filter((i) => i.kind === "tombstone").length).toBeGreaterThan(0);
    // a child's parent is set after every row is in
    expect(items.some((i) => i.kind === "refs" && i.table === "content_nodes" && i.values.parent_id === root)).toBe(true);
    // never what the owner cannot read, never what stays on a node
    const text = JSON.stringify(pages);
    expect(text).not.toContain("Friend only");
    expect(text).not.toContain(secretNote);
    expect(items.filter((i) => i.kind === "row" && i.table === "actor_prefs").map((i) => String((i as { values: Record<string, unknown> }).values.actor_id))).toEqual([owner.id]);
  });

  it("a note's hidden 「內容」 tab travels in the snapshot with the stamps of its record, and the text is still the note's", async () => {
    const items = (await read(owner)).pages.flatMap((p) => p.items);
    const record = items.find((i) => i.kind === "row" && i.table === "function_refs" && i.values.function_id === "content");
    expect(record).toBeDefined();
    expect(JSON.stringify((record as { values: Record<string, unknown> }).values)).toContain('"hidden":true');
    expect((record as { stamps: Array<{ label: string }> }).stamps.some((stamp) => stamp.label === "function_refs.config")).toBe(true);
    const rootRow = items.find((i) => i.kind === "row" && i.table === "content_nodes" && i.values.id === root) as { values: Record<string, unknown> };
    expect(rootRow.values.markdown).toBe("text of Root");
  });

  it("its digest is the digest of what is in the database, table by table, and the tables of the test all have rows", async () => {
    const { summary } = await read(owner);
    const mine = await withActorReadSnapshot(owner, ws, async (actor) => computeSnapshotDigest(ws, await snapshotScopeFor(actor)));
    expect(compareDigests(summary.digest, mine)).toEqual([]);
    const rows = Object.fromEntries(summary.digest.map((d) => [d.table, d.rows]));
    for (const table of ["workspaces", "actors", "spaces", "space_members", "content_nodes", "node_tags", "node_attributes", "node_edges", "node_positions", "function_refs", "actor_prefs"]) expect(rows[table], table).toBeGreaterThan(0);
    expect(summary.digest.map((d) => d.table)).toEqual(SNAPSHOT_SPECS.map((s) => s.table));
    // a different reader reads different notes: the friend's digest is not the owner's, and has the secret note
    const theirs = await read(friend);
    expect(JSON.stringify(theirs.pages)).toContain("Friend only");
    expect(compareDigests(summary.digest, theirs.summary.digest).some((d) => d.table === "content_nodes" && d.what === "rows")).toBe(true);
  });

  it("refuses what is not done, a token, and a workspace that holds the stamps of another node", async () => {
    const none = async () => undefined;
    await expect(readStampedPages(owner, ws, { since: { somewhere: 1 } as never, layer: "rows" }, none)).rejects.toMatchObject({ code: "snapshot_since_not_done" });
    await expect(readStampedPages(owner, ws, { since: null, layer: "history" }, none)).rejects.toMatchObject({ code: "snapshot_layer_not_done" });
    await expect(readStampedPages(owner, ws, { since: null, layer: "blobs" }, none)).rejects.toMatchObject({ code: "snapshot_layer_not_done" });
    await expect(readStampedPages({ ...owner, tokenScope: { access: "read", allowedTools: [], tokenId: "t" } as never }, ws, { since: null, layer: "rows" }, none)).rejects.toThrow(/reserved to a person/);
    await seedQ(`INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, deleted) VALUES ($1, 'content_nodes', $2, '*', 'another-node', 9, 1, 0, false)`, [ws, randomUUID()]);
    try {
      await expect(readStampedPages(owner, ws, { since: null, layer: "rows" }, none)).rejects.toMatchObject({ code: "snapshot_foreign_origin", status: 409 });
    } finally {
      await seedQ(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND origin = 'another-node'`, [ws]); // the other tests of this file run in any order
    }
  });
});
