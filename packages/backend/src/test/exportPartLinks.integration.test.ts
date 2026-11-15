// A single note's Markdown file with part links (services/exportPartLinks.ts): three ways to write
// `[[筆記/段落開頭]]` for a reader outside Onden. SAFETY: only runs against a *_test database.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { createNote } from "../services/noteCreate.js";
import { createBlockLink } from "../services/blockLinks.js";
import { exportedSingleNoteFile } from "../services/exportZip.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "export-part-links", name: "Exporter", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
registerShippedModules();

const note = async (title: string, markdown: string) =>
  String((await createNote({ actor, workspaceId, title, markdown, event: { uiContext: "test" } })).node.id);
const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;

describe.skipIf(!isTestDb)("export: part links (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('ExportPartLinks',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  async function scene() {
    const tag = randomUUID().slice(0, 6);
    const targetBody = `前言\n\n17:45–21:15 吃飯 ${tag}，聊到很晚。\n`;
    const target = await note(`吃飯紀錄-${tag}`, targetBody);
    const source = await note(`日記-${tag}`, "今天\n");
    const made = await createBlockLink({ workspaceId, actor, targetNoteId: target, sourceNoteId: source, at: targetBody.indexOf("17:45"), seenText: "17:45–21:15 吃飯" });
    const sourceBody = `今天 見 [[${made.link}|那一餐]]。\n`;
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [source, sourceBody]);
    return { tag, target, source, made, sourceBody };
  }

  it("default: the note link and the paragraph's words", async () => {
    const s = await scene();
    const file = (await exportedSingleNoteFile(actor, workspaceId, s.source, { title: `日記-${s.tag}`, markdown: s.sourceBody }))!;
    expect(file).toContain(`今天 見 [[吃飯紀錄-${s.tag}|那一餐]]：17:45–21:15 吃飯 ${s.tag}，聊到很晚。`);
    expect(file).not.toContain("#^");
  });

  it("footnote: a marker in the text, the note's name and the paragraph in a footnote", async () => {
    const s = await scene();
    const file = (await exportedSingleNoteFile(actor, workspaceId, s.source, { title: `日記-${s.tag}`, markdown: s.sourceBody }, "footnote"))!;
    expect(file).toContain("今天 見 那一餐[^part-1]。");
    expect(file).toContain(`[^part-1]: 吃飯紀錄-${s.tag}：17:45–21:15 吃飯 ${s.tag}，聊到很晚。`);
  });

  it("obsidian: [[筆記#^id]] to the bound anchor", async () => {
    const s = await scene();
    const file = (await exportedSingleNoteFile(actor, workspaceId, s.source, { title: `日記-${s.tag}`, markdown: s.sourceBody }, "obsidian"))!;
    expect(file).toContain(`[[吃飯紀錄-${s.tag}#^${s.made.anchorId}|那一餐]]`);
    // The export is a copy: nothing was written into either note.
    expect(await bodyOf(s.target)).toBe(`前言\n\n17:45–21:15 吃飯 ${s.tag}，聊到很晚。\n`);
  });

  it("obsidian: a linked paragraph of the exported note itself gets ` ^id` at its line end", async () => {
    const tag = randomUUID().slice(0, 6);
    const body = `結論在這裡 ${tag}\n\n其他段落\n`;
    const self = await note(`自己-${tag}`, body);
    const made = await createBlockLink({ workspaceId, actor, targetNoteId: self, sourceNoteId: self, at: 0, seenText: `結論在這裡 ${tag}` });
    const draft = `${body}回頭看 [[${made.link}]]\n`;
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [self, draft]);
    const file = (await exportedSingleNoteFile(actor, workspaceId, self, { title: `自己-${tag}`, markdown: draft }, "obsidian"))!;
    expect(file).toContain(`結論在這裡 ${tag} ^${made.anchorId}\n`);
    expect(file).toContain(`回頭看 [[自己-${tag}#^${made.anchorId}]]`);
  });

  it("with no reader (nothing may be read) the other note is neither named nor quoted: the link stays as written", async () => {
    const s = await scene();
    const file = (await exportedSingleNoteFile(null, workspaceId, s.source, { title: `日記-${s.tag}`, markdown: s.sourceBody }))!;
    expect(file).toContain(`[[${s.made.link}|那一餐]]`);
    expect(file).not.toContain("聊到很晚");
  });
});
