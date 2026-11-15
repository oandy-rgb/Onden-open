// An excerpt (a quote with its source line) is anchored as it is written, so it is known by identity: a part link to it
// binds, the reader finds it again, and an export expands it. SAFETY: only runs against a *_test database.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { excerptBlock, parseExcerpts } from "@onden/markdown";
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { createNote } from "../services/noteCreate.js";
import { updateNode } from "../services/nodeUpdate.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "excerpt-anchors", name: "Reader", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
registerShippedModules();

const SOURCE = { title: "An Article", url: "https://example.com/a", feed: "Daily News" };
const anchorsOf = async (noteId: string) => (await q<{ anchor_id: string; from_utf16: number; status: string }>(
  `SELECT anchor_id, from_utf16, status FROM block_anchors WHERE note_id = $1 ORDER BY from_utf16`, [noteId])).rows;
const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;

describe.skipIf(!isTestDb)("excerpts get an anchor when they are written (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('ExcerptAnchors',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  it("an appended excerpt is anchored by the save; a plain quote and a plain paragraph are not; saving again adds none", async () => {
    const id = String((await createNote({ actor, workspaceId, title: `摘錄-${randomUUID().slice(0, 6)}`, markdown: "前言\n", event: { uiContext: "test" } })).node.id);
    expect(await anchorsOf(id)).toEqual([]);

    const body = `前言\n\n${excerptBlock({ exact: "The fox", prefix: "See" }, SOURCE)}\n\n> 只是引文\n\n普通段落\n`;
    await updateNode(workspaceId, id, { markdown: body }, { actor, baseMarkdown: "前言\n" });
    const made = await anchorsOf(id);
    expect(made).toHaveLength(1);
    expect(made[0]!.status).toBe("valid");
    // The anchor is what makes it an excerpt to the reader.
    const markdown = await bodyOf(id);
    expect(parseExcerpts(markdown, made.map((a) => ({ id: a.anchor_id, from: a.from_utf16, to: markdown.length }))).map((e) => e.exact)).toEqual(["The fox"]);

    await updateNode(workspaceId, id, { markdown: `${body}\n結尾\n` }, { actor, baseMarkdown: body });
    expect((await anchorsOf(id)).map((a) => a.anchor_id)).toEqual(made.map((a) => a.anchor_id));
  });

  it("a note created with an excerpt in it has it anchored", async () => {
    const id = String((await createNote({ actor, workspaceId, title: `新摘錄-${randomUUID().slice(0, 6)}`, markdown: excerptBlock({ exact: "Quoted" }, SOURCE), event: { uiContext: "test" } })).node.id);
    expect(await anchorsOf(id)).toHaveLength(1);
  });
});
