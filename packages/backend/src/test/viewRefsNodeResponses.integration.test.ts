// The answer to a note write (PATCH /api/nodes/:id, promote, create, duplicate) is the row the client stores. Since
// migration 188 the views live in function_refs and the collection_views column is frozen, so the answer must carry the
// views composed from the references — a NULL or stale array would overwrite the client's store (a whiteboard
// stops being a whiteboard until the next sync).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { createNote } from "../services/noteCreate.js";
import { duplicateNote } from "../services/noteDuplicate.js";
import { promoteNode } from "../services/nodePromote.js";
import { updateNode } from "../services/nodeUpdate.js";
import { createNoteView, updateNoteView } from "../services/noteViews.js";
import { viewCreateSchema } from "../services/tagViews.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

registerShippedModules();

type Views = Array<{ id: string; layout: string; name?: string; layout_config?: Record<string, unknown> }> | null;

describe.skipIf(!isTestDatabase())("note write answers carry the views (DB)", () => {
  const admin: ActorCtx = { id: "vrn-admin", name: "Admin", role: "admin", type: "human" };
  let WS = "";
  const board = async () => {
    const created = await createNote({ actor: admin, workspaceId: WS, title: `Board ${randomUUID().slice(0, 6)}`, markdown: "text\n", event: { uiContext: "test.vrn" } });
    const id = String(created.node.id);
    const tab = await createNoteView(admin, WS, id, viewCreateSchema.parse({ name: "Canvas", layout: "canvas", layout_config: { opens_first: true } }));
    // The column stays what it was: nothing but the references says there is a tab.
    expect((await q<{ v: unknown }>(`SELECT collection_views AS v FROM content_nodes WHERE id = $1`, [id])).rows[0]!.v).toBeNull();
    return { id, tab: tab!.id };
  };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
  });

  it("an edit answers with the whiteboard tab, a hidden tab and a renamed view as the references say", async () => {
    const { id, tab } = await board();
    const edited = await updateNode(WS, id, { title: "Renamed board" }, { actor: admin });
    expect((edited.node as { collection_views: Views }).collection_views).toMatchObject([{ id: tab, layout: "canvas", layout_config: { opens_first: true } }]);

    await updateNoteView(admin, WS, id, tab, { layout_config: { hidden: true } });
    const again = await updateNode(WS, id, { markdown: "more text\n" }, { actor: admin });
    expect((again.node as { collection_views: Views }).collection_views).toMatchObject([{ id: tab, layout_config: { hidden: true } }]);
  });

  it("an edit that changes nothing answers with the views too", async () => {
    const { id, tab } = await board();
    const noop = await updateNode(WS, id, {}, { actor: admin });
    expect(noop.noop).toBe(true);
    expect((noop.node as { collection_views: Views }).collection_views?.map((v) => v.id)).toEqual([tab]);
  });

  it("a note without views answers with none, promote answers with the views, a duplicate has none of the original's", async () => {
    const { id, tab } = await board();
    await seedQ(`UPDATE content_nodes SET hidden = true WHERE id = $1`, [id]);
    const promoted = await promoteNode(admin, WS, id);
    expect((promoted as { collection_views: Views }).collection_views?.map((v) => v.id)).toEqual([tab]);

    const plain = await createNote({ actor: admin, workspaceId: WS, title: `Plain ${randomUUID().slice(0, 6)}`, markdown: "x\n", event: { uiContext: "test.vrn" } });
    expect((plain.node as { collection_views: Views }).collection_views ?? null).toBeNull();
    const copy = await duplicateNote({ workspaceId: WS, actor: admin, sourceId: id });
    expect((copy.node as { collection_views: Views }).collection_views ?? null).toBeNull();
  });

  it("a note created with a whiteboard tab answers with the tab", async () => {
    const { addWhiteboardTab } = await import("../services/boardStore.js");
    const made = await createNote({
      actor: admin, workspaceId: WS, title: `Made ${randomUUID().slice(0, 6)}`, markdown: "m\n",
      event: { uiContext: "test.vrn" }, within: ({ nodeId }) => addWhiteboardTab(nodeId),
    });
    expect((made.node as { collection_views: Views }).collection_views).toMatchObject([{ layout: "canvas", layout_config: { opens_first: true } }]);
  });
});
