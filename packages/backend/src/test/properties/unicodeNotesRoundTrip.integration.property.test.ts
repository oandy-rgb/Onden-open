// Property: notes with Chinese and Unicode titles and bodies come through the
// database, the Markdown export and the folder import with the same title and the
// same text — full-width brackets (balanced or not: "_Inbox（暫存" has no closing
// bracket on purpose), Windows-forbidden characters, dots and blanks at the ends,
// emoji, combining marks, zero-width characters, CRLF. The file names in the zip
// stay within what a disk accepts (255 bytes a name, no forbidden character).
// Generators: markdown/src/test/helpers/unicodeText.ts. Seed and run count from
// PROPS_SEED / PROPS_RUNS. Skips unless DATABASE_URL names a *_test database.

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { normalizeText } from "@onden/markdown";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { hostileTitle, proseBody } from "../../../../markdown/src/test/helpers/unicodeText.js";
import { freshWorkspace, snapshotWorkspace } from "../helpers/roundTripWorld.js";
import { exportMarkdown, importFiles, zipFiles } from "../helpers/roundTripApi.js";
import { expectNotesSurvive } from "../helpers/roundTripCompare.js";
import { createNote } from "../../services/noteCreate.js";
import { updateNode } from "../../services/nodeUpdate.js";
import { createTag, TagNameConflictError } from "../../services/tagHierarchy.js";
import { titleText } from "../../../../markdown/src/test/helpers/unicodeText.js";
import { q } from "../../db.js";

vi.mock("../../db.js", async (original) => {
  const { workspaceSwitch } = await import("../helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});

const enabled = isTestDatabase();
// Each run builds, exports and imports a workspace: a fifth of PROPS_RUNS (25 on the default 200, 500 in the nightly 5000 → capped at 500).
const runs = Math.min(Math.max(25, Math.floor(PROPS_RUNS / 8)), 500);
const TIMEOUT = 20 * 60_000;

/** Notes whose titles are distinct as the app compares them (NFC, lower case) and whose slugs are not empty. */
const notes = fc
  .uniqueArray(fc.record({ title: hostileTitle, body: proseBody.map((text) => `${text}\n`) }), { minLength: 1, maxLength: 5, selector: (n) => normalizeText(n.title).toLowerCase() })
  .filter((list) => list.every((n) => normalizeText(n.title).length <= 500));

describe.skipIf(!enabled)("Chinese and Unicode notes: database, export, import", () => {
  it("a note's title is stored in NFC and its text exactly as written (CRLF, zero-width characters kept)", async () => {
    await fc.assert(fc.asyncProperty(notes, async (list) => {
      const { ws, actor } = await freshWorkspace("uni-store");
      for (const n of list) {
        const { node } = await createNote({ actor, workspaceId: ws, title: n.title, markdown: n.body, event: { uiContext: "test.unicode" } });
        const row = (await q<{ title: string; markdown: string }>(`SELECT title, markdown FROM content_nodes WHERE id = $1`, [node.id as string])).rows[0]!;
        expect(row.title).toBe(normalizeText(n.title));
        expect(row.markdown).toBe(n.body);
      }
    }), { seed: PROPS_SEED, numRuns: runs });
  }, TIMEOUT);

  it("export then import gives every note back with its title and text", async () => {
    await fc.assert(fc.asyncProperty(notes, async (list) => {
      const a = await freshWorkspace("uni-a");
      for (const n of list) await createNote({ actor: a.actor, workspaceId: a.ws, title: n.title, markdown: n.body, event: { uiContext: "test.unicode" } });
      const before = await snapshotWorkspace(a.ws);
      const zip = await exportMarkdown(a.ws, a.actor);

      // Every file name fits a disk.
      for (const name of zip.keys()) {
        for (const part of name.split("/")) {
          expect(Buffer.byteLength(part, "utf8"), `file name part of ${JSON.stringify(name)}`).toBeLessThanOrEqual(255);
          expect(part, `file name part of ${JSON.stringify(name)}`).not.toMatch(/[<>:"\\|?*\u0000-\u001f]/);
        }
      }

      const b = await freshWorkspace("uni-b");
      const report = await importFiles(b.ws, b.actor, zipFiles(zip));
      expect(report.skipped, JSON.stringify(report.conflicts)).toBe(0);
      const after = await snapshotWorkspace(b.ws);
      expectNotesSurvive(before, after, zip); // same titles, same text (the import's one added trailing newline allowed for)
    }), { seed: PROPS_SEED, numRuns: runs });
  }, TIMEOUT);

  it("current behaviour: a body without a final newline comes back with one (the export's file ends in a newline)", async () => {
    const a = await freshWorkspace("uni-nl");
    await createNote({ actor: a.actor, workspaceId: a.ws, title: "尾端換行", markdown: "沒有換行", event: { uiContext: "test.unicode" } });
    const b = await freshWorkspace("uni-nl-b");
    await importFiles(b.ws, b.actor, zipFiles(await exportMarkdown(a.ws, a.actor)));
    expect((await snapshotWorkspace(b.ws)).notes.find((n) => n.title === "尾端換行")!.body).toBe("沒有換行\n");
  });

  it("a title of 200 Chinese characters (600 bytes) exports under file names a disk accepts and imports back whole", async () => {
    const title = "長".repeat(200);
    const a = await freshWorkspace("uni-long");
    await createNote({ actor: a.actor, workspaceId: a.ws, title, markdown: "內文\n", event: { uiContext: "test.unicode" } });
    const zip = await exportMarkdown(a.ws, a.actor);
    for (const name of zip.keys()) for (const part of name.split("/")) expect(Buffer.byteLength(part, "utf8"), name).toBeLessThanOrEqual(255);
    const b = await freshWorkspace("uni-long-b");
    await importFiles(b.ws, b.actor, zipFiles(zip));
    expect((await snapshotWorkspace(b.ws)).notes.map((n) => n.title)).toEqual([title]);
  });

  it("a vault folder named with an opening full-width bracket only imports as that title, and exports back the same", async () => {
    const a = await freshWorkspace("uni-brackets");
    const files = [
      { path: "_Inbox（暫存/一則筆記.md", content: "內容\n" },
      { path: "1.Project（專案/規劃.md", content: "計畫\n" },
    ];
    await importFiles(a.ws, a.actor, files);
    const titles = (await snapshotWorkspace(a.ws)).notes.map((n) => n.title).sort();
    expect(titles).toEqual(expect.arrayContaining(["_Inbox（暫存", "1.Project（專案", "一則筆記", "規劃"]));
    const zip = await exportMarkdown(a.ws, a.actor);
    const b = await freshWorkspace("uni-brackets-b");
    await importFiles(b.ws, b.actor, zipFiles(zip));
    expect((await snapshotWorkspace(b.ws)).notes.map((n) => n.title).sort()).toEqual(titles);
  });

  it("renaming to any title stores it in NFC and loses no character", async () => {
    const { ws, actor } = await freshWorkspace("uni-rename");
    const { node } = await createNote({ actor, workspaceId: ws, title: "舊名稱", markdown: "", event: { uiContext: "test.unicode" } });
    await fc.assert(fc.asyncProperty(hostileTitle, async (title) => {
      fc.pre(normalizeText(title).length <= 500);
      await updateNode(ws, node.id as string, { title }, { actor });
      const row = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [node.id as string])).rows[0]!;
      expect(row.title).toBe(normalizeText(title));
    }), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, 100) });
  }, TIMEOUT);

  describe("tag names", () => {
    it("a tag named in NFD is the tag named in NFC: the second is a name conflict", async () => {
      const { ws, actor } = await freshWorkspace("uni-tags");
      await fc.assert(fc.asyncProperty(titleText, async (name) => {
        fc.pre(/^[^/#,:{}\s]+$/.test(name) && normalizeText(name).normalize("NFD") !== normalizeText(name));
        const { ws: w, actor: a } = await freshWorkspace("uni-tag-one");
        await createTag({ actor: a, workspaceId: w, name: normalizeText(name) });
        await expect(createTag({ actor: a, workspaceId: w, name: normalizeText(name).normalize("NFD") })).rejects.toBeInstanceOf(TagNameConflictError);
      }), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, 40) });
      void ws; void actor;
    }, TIMEOUT);

    it("current behaviour: full-width Ａ and A, or a zero-width character inside, make different tags", async () => {
      const { ws, actor } = await freshWorkspace("uni-tags-2");
      const names = ["Ａ計畫", "A計畫", "計\u200b畫", "計畫"];
      for (const name of names) await createTag({ actor, workspaceId: ws, name });
      expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND reserved_key IS NULL ORDER BY title`, [ws])).rows.map((r) => r.title).sort())
        .toEqual([...names].sort());
    });
  });
});
