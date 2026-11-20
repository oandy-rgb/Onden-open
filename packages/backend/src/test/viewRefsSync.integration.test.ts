// A saved view is a function reference (migration 188), but clients still read it off the node row as
// `collection_views`: the server composes that array from the references on every surface a client stores
// (bootstrap, the sync delta, GET /api/nodes/:id), so an offline copy — and a copy made before the move — keeps
// seeing the same views, and a change to a view reaches a device that syncs afterwards.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";
import { buildBootstrap } from "../services/sync/bootstrap.js";
import { buildSyncDelta } from "../services/sync/index.js";
import { getLiveNodeRow } from "../services/nodeReads.js";
import { createNoteView, deleteNoteView, updateNoteView } from "../services/noteViews.js";
import { createTagView, viewCreateSchema } from "../services/tagViews.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

registerShippedModules();

type Row = { id: string; collection_views?: Array<{ id: string; name?: string; layout: string; layout_config?: Record<string, unknown> }> | null };

describe.skipIf(!isTestDatabase())("saved views on every row a client stores (DB)", () => {
  const admin: ActorCtx = { id: "vrsync-admin", name: "Admin", role: "admin", type: "human" };
  let WS = "";
  let tag = "", note = "";
  const stamp = randomUUID().slice(0, 8);
  const cursor = async () => Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events`)).rows[0]!.m);
  const make = (body: Record<string, unknown>) => viewCreateSchema.parse(body);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
    tag = (await seedClassTag(WS, { name: `VR ${stamp}`, slug: `vr-${stamp}`, nodeSlug: `vr-tag-${stamp}` })).tagId;
    note = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, 'manual', 'content', $2, $3, '') RETURNING id::text`,
      [WS, `VR note ${stamp}`, `vr-note-${stamp}`])).rows[0]!.id;
  });

  it("the node rows of a tag and of a note carry their views in the old shape, and a note without any has none", async () => {
    const a = await createTagView(admin, WS, tag, make({ name: "Tag table", layout: "table", pin_order: 2 }));
    const b = await createNoteView(admin, WS, note, make({ name: "Note board", layout: "kanban", group_by: "stage" }));
    const rows = (await getNodeRows([tag, note])) as Row[];
    expect(rows.find((r) => r.id === tag)!.collection_views).toMatchObject([{ id: a!.id, tag_id: tag, name: "Tag table", layout: "table", pin_order: 2, filters: [], sorts: [] }]);
    expect(rows.find((r) => r.id === note)!.collection_views).toMatchObject([{ id: b!.id, node_id: note, name: "Note board", layout: "kanban", group_by: "stage" }]);
    const plain = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, 'manual', 'content', $2, $3, '') RETURNING id::text`,
      [WS, `VR plain ${stamp}`, `vr-plain-${stamp}`])).rows[0]!.id;
    expect(((await getNodeRows([plain])) as Row[])[0]!.collection_views ?? null).toBeNull();
  });

  /** The row as the bootstrap sends it (the client stores it as it is). */
  async function getNodeRows(ids: string[]): Promise<Row[]> {
    const boot = await buildBootstrap(admin, WS, { slimBodies: false }) as unknown as { nodes: Row[] };
    return boot.nodes.filter((r) => ids.includes(r.id));
  }

  it("a view made, renamed and removed after a device last synced reaches it through the delta", async () => {
    const since = await cursor();
    const made = await createNoteView(admin, WS, note, make({ name: `Later ${stamp}`, layout: "gallery" }));
    let delta = await buildSyncDelta(admin, WS, { since, known: [] });
    const shipped = (delta.nodes.upsert as unknown as Row[]).find((r) => r.id === note);
    expect(shipped?.collection_views?.map((v) => v.name)).toContain(`Later ${stamp}`);

    const afterMake = await cursor();
    expect(await updateNoteView(admin, WS, note, made!.id, { name: `Renamed ${stamp}`, layout_config: { opens_first: true } })).toBe(true);
    delta = await buildSyncDelta(admin, WS, { since: afterMake, known: [] });
    expect((delta.nodes.upsert as unknown as Row[]).find((r) => r.id === note)?.collection_views?.find((v) => v.id === made!.id))
      .toMatchObject({ name: `Renamed ${stamp}`, layout_config: { opens_first: true } });

    const afterRename = await cursor();
    expect(await deleteNoteView(admin, WS, note, made!.id)).toBe(true);
    delta = await buildSyncDelta(admin, WS, { since: afterRename, known: [] });
    expect((delta.nodes.upsert as unknown as Row[]).find((r) => r.id === note)?.collection_views?.map((v) => v.id) ?? []).not.toContain(made!.id);
  });

  it("the 「內容」 flag the server clears when the last other tab goes is in the same delta as that removal: another device does not keep the old flag", async () => {
    const own = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, 'manual', 'content', $2, $3, '') RETURNING id::text`,
      [WS, `VR content ${stamp}`, `vr-content-${stamp}`])).rows[0]!.id;
    const table = await createNoteView(admin, WS, own, make({ name: "Shelf", layout: "table" }));
    const record = await createNoteView(admin, WS, own, make({ name: "Content", layout: "content", layout_config: { hidden: true } }));
    const since = await cursor();
    expect(await deleteNoteView(admin, WS, own, table!.id)).toBe(true); // the server clears the flag in this same transaction
    const delta = await buildSyncDelta(admin, WS, { since, known: [] });
    const shipped = (delta.nodes.upsert as unknown as Row[]).find((r) => r.id === own);
    expect(shipped?.collection_views?.find((v) => v.id === record!.id)?.layout_config?.hidden ?? null).toBeNull();
  });

  it("GET /api/nodes/:id reads the same array", async () => {
    const own = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, 'manual', 'content', $2, $3, '') RETURNING id::text`,
      [WS, `VR own ${stamp}`, `vr-own-${stamp}`])).rows[0]!.id;
    const made = await createNoteView(admin, WS, own, make({ name: "Own board", layout: "canvas", layout_config: { opens_first: true } }));
    const row = await getLiveNodeRow(admin, WS, own) as unknown as Row | null;
    expect(row?.collection_views).toMatchObject([{ id: made!.id, node_id: own, name: "Own board", layout: "canvas", layout_config: { opens_first: true } }]);
  });
});
