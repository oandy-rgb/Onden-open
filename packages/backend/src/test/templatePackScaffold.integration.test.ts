// "New from template: Meeting notes" with the Meeting starter pack installed
// (D69). The pack stamps no child notes (a note only fills in fields; structure
// lives on the tag's page), so the app's template writes its own body and the
// pack's required date, and the note has no children.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { q } from "../db.js";
import { createNote } from "../services/noteCreate.js";
import { installTagPackApproved, validateTagPack } from "../services/tagPacks.js";
import { readTagCatalog } from "../services/tagCatalog.js";
import { localDayId } from "../localDay.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("Meeting template with the Meeting pack: the template writes the body (D69)", () => {
  let ws = "";
  let actor: ActorCtx = { id: "d69-owner", name: "Owner", role: "admin", type: "human" };
  let tagId = "";
  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('D69', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(ws, actor);
    // The pack the welcome card offers, as shipped.
    const shipped = JSON.parse(readFileSync(new URL("../../../frontend/src/data/packs/meeting.tagpack.json", import.meta.url), "utf8"));
    const checked = validateTagPack(shipped);
    if (!checked.ok) throw new Error(checked.error);
    tagId = (await installTagPackApproved(ws, { actorId: actor.id, actorType: "user" }, checked.pack)).id;
  });

  it("the catalog shows the shipped pack's tag with no template children", async () => {
    const tag = (await readTagCatalog(actor, ws)).find((row) => row.id === tagId) as Record<string, unknown> | undefined;
    expect(tag?.schema_template_children ?? []).toEqual([]);
  });

  it("creating the note as the app's template does gives its body and the date, and no children", async () => {
    const today = localDayId();
    // What useNodeCreation.createFromTemplate("meeting") sends: the template's
    // body, the tag, the pack's date.
    const { node } = await createNote({
      actor, workspaceId: ws, title: `Meeting — ${today} 09:00`, markdown: `# Meeting — ${today} 09:00\n\n## Agenda\n- \n`,
      tagIds: [tagId], attributes: [{ key: "meeting_date", value: today }],
      event: { uiContext: "test.d69" },
    });
    const id = node.id as string;
    const children = await q<{ title: string }>(
      `SELECT title FROM content_nodes WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY order_key COLLATE "C", order_stamp COLLATE "C", id`, [id]);
    expect(children.rows).toEqual([]);
    const body = await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id]);
    expect(body.rows[0]!.markdown).toContain("## Agenda");
    const date = await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'meeting_date'`, [id]);
    expect(date.rows.map((r) => r.value)).toEqual([today]);
  });
});
