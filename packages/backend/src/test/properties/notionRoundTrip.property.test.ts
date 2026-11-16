// Round trip 4: a Notion database export (CSV + page files) → import.
//
// fast-check generates Notion exports (helpers/roundTripNotion.ts): databases
// as `<DB>.csv` + `<DB>_all.csv`, row pages as `<DB>/<Title> <hash>.md`, pages
// beside them, every page with a token of its own. The export is imported
// through POST /api/import/obsidian and each note is read back with its body
// and attributes. What an import must give:
//   - one note per CSV row (a row's `Name` and its unique `Status` tell it apart),
//   - every page's text in exactly one note: none lost, none twice,
//   - a row holds only its own page's text, and does hold it when its page can
//     be told from the others (the only page of that title in its database's
//     folder, and the only row of that title there). A Notion CSV has no page
//     ids, so a repeated title cannot be matched by guessing.
// Replay a failing export with ROUNDTRIP_SEED=<seed>.
//
// The tests with `.fails` are review item #7 (importNotionDatabase.ts matches
// a row to a page by title across the whole export): fix/a2-structure-import-
// backup. They go red when the fix lands, and the `.fails` comes off.

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { q } from "../../db.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { roundTripRuns } from "../helpers/roundTripArb.js";
import { freshWorkspace } from "../helpers/roundTripWorld.js";
import { importFiles } from "../helpers/roundTripApi.js";
import { notionFiles, notionSpec, type NotionSpec } from "../helpers/roundTripNotion.js";
import { titleIdentity } from "../helpers/roundTripArb.js";

vi.mock("../../db.js", async (original) => {
  const { workspaceSwitch } = await import("../helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});

const enabled = isTestDatabase();

type NoteRow = { title: string; markdown: string; status: string | null; name: string | null };

async function importNotion(spec: NotionSpec) {
  const { files, pages } = notionFiles(spec);
  const w = await freshWorkspace("rt-notion");
  const report = await importFiles(w.ws, w.actor, files);
  const notes = (await q<NoteRow>(
    `SELECT n.title, COALESCE(n.markdown, '') AS markdown,
            (SELECT value FROM node_attributes a WHERE a.node_id = n.id AND a.key = 'Status') AS status,
            (SELECT value FROM node_attributes a WHERE a.node_id = n.id AND a.key = 'Name') AS name
       FROM content_nodes n
      WHERE n.workspace_id = $1 AND n.node_type = 'content' AND n.deleted_at IS NULL AND NOT n.hidden`, [w.ws])).rows;
  return { report, notes, pages };
}

/** The contract above, as assertions. */
function expectRightBodies(spec: NotionSpec, { notes, pages }: Awaited<ReturnType<typeof importNotion>>): void {
  // Every page's text is in exactly one note.
  for (const page of pages) {
    const holders = notes.filter((n) => n.markdown.includes(page.token));
    expect(holders.map((n) => n.title), `notes holding ${page.path}`).toHaveLength(1);
  }
  for (const db of spec.databases) {
    for (const row of db.rows) {
      const found = notes.filter((n) => n.status === row.status);
      expect(found, `row ${db.name}/${row.title} (${row.status})`).toHaveLength(1);
      const note = found[0]!;
      expect(note.name, `Name of ${row.status}`).toBe(row.title);
      const own = pages.find((p) => p.rowStatus === row.status);
      // Only its own page's text, never another page's.
      for (const page of pages) if (page !== own) expect(note.markdown, `${db.name}/${row.title} holds the text of ${page.path}`).not.toContain(page.token);
      // Its own, when the title tells the page from the others.
      const sameTitle = (t: string) => titleIdentity(t) === titleIdentity(row.title);
      const alone = db.rows.filter((r) => sameTitle(r.title)).length === 1 && pages.filter((p) => p.db === db.name && sameTitle(p.title)).length === 1;
      if (own && alone) expect(note.markdown, `${db.name}/${row.title} holds its page`).toContain(own.token);
    }
  }
}

describe.skipIf(!enabled)("Notion database CSV + pages → import", () => {
  it("rows and pages with titles of their own import into distinct notes with the right bodies", async () => {
    await fc.assert(fc.asyncProperty(notionSpec("none"), async (spec) => {
      const result = await importNotion(spec);
      expect(result.report.skipped, JSON.stringify(result.report.conflicts)).toBe(0);
      expectRightBodies(spec, result);
    }), roundTripRuns());
  }, 300_000);

  // KNOWN: review #7 — fix/a2-structure-import-backup. indexPageBodies keys a
  // row's page by title over the whole export, the later file replacing the
  // earlier: two rows of one title get the same page and the other page
  // becomes a separate note.
  it("KNOWN #7 (fix/a2-structure-import-backup): two rows with the same title in one database each keep to their own text", async () => {
    await fc.assert(fc.asyncProperty(notionSpec("sameDb"), async (spec) => expectRightBodies(spec, await importNotion(spec))), roundTripRuns({ maxRuns: 4 }));
  }, 300_000);

  // KNOWN: review #7 — same title in two databases: both rows get the page
  // that happens to come last, whichever folder it is in.
  it("KNOWN #7 (fix/a2-structure-import-backup): rows of the same title in two databases get the page of their own database", async () => {
    await fc.assert(fc.asyncProperty(notionSpec("twoDbs"), async (spec) => expectRightBodies(spec, await importNotion(spec))), roundTripRuns({ maxRuns: 4 }));
  }, 300_000);

  // KNOWN: review #7 — a page outside the database with a row's title is
  // taken as the row's body, and the row's own page is imported on its own.
  it("KNOWN #7 (fix/a2-structure-import-backup): a page elsewhere with a row's title is not taken for the row's body", async () => {
    await fc.assert(fc.asyncProperty(notionSpec("looseSameTitle"), async (spec) => expectRightBodies(spec, await importNotion(spec))), roundTripRuns({ maxRuns: 4 }));
  }, 300_000);

  it("pages with the same title in different folders (no database) import into distinct notes with their own text", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("Untitled", "Meeting notes", "會議紀錄"), { minLength: 2, maxLength: 4 }), fc.uniqueArray(fc.constantFrom("A", "B", "C 資料", "D/E"), { minLength: 2, maxLength: 4 }), async (titles, folders) => {
      const spec: NotionSpec = { databases: [], loose: folders.flatMap((folder) => titles.slice(0, 2).map((title) => ({ folder, title }))) };
      const { files, pages } = notionFiles(spec);
      const w = await freshWorkspace("rt-notion");
      await importFiles(w.ws, w.actor, files);
      const rows = (await q<{ title: string; markdown: string; parent: string | null }>(
        `SELECT n.title, n.markdown, p.title AS parent FROM content_nodes n LEFT JOIN content_nodes p ON p.id = n.parent_id
          WHERE n.workspace_id = $1 AND n.node_type = 'content' AND n.deleted_at IS NULL`, [w.ws])).rows;
      for (const page of pages) {
        const holders = rows.filter((n) => n.markdown.includes(page.token));
        expect(holders, `notes holding ${page.path}`).toHaveLength(1);
        expect(holders[0]!.parent, `folder of ${page.path}`).toBe(page.path.includes("/") ? page.path.split("/").slice(-2)[0] : null);
      }
    }), roundTripRuns());
  }, 300_000);

  // Scan 14 #5. A database whose tag name is already taken (the same export imported again) is not made; the import says
  // so for each of them instead of reporting only the loose pages that came in because of it.
  const databaseConflicts = (report: { conflicts: Array<{ path: string; reason: string }> }) => report.conflicts.filter((c) => c.reason === "database_unavailable");

  it("importing a Notion export a second time lists every database it could not create", async () => {
    await fc.assert(fc.asyncProperty(notionSpec("none"), async (spec) => {
      const { files } = notionFiles(spec);
      const w = await freshWorkspace("rt-notion-again");
      const first = await importFiles(w.ws, w.actor, files);
      expect(databaseConflicts(first), "first import").toEqual([]);
      const second = await importFiles(w.ws, w.actor, files);
      const listed = databaseConflicts(second).map((c) => c.path.split("/")[0]!.replace(/(_all)?\.csv$/, "")).sort();
      expect(listed).toEqual(spec.databases.map((d) => d.name).sort());
      expect(second.skipped, "skipped counts them").toBeGreaterThanOrEqual(spec.databases.length);
    }), roundTripRuns({ maxRuns: 6 }));
  }, 300_000);

  it("a CSV whose name is a tag already there is listed as not created (fixed case)", async () => {
    const files = [{ path: "Books.csv", content: "Name,Status\nDune,s1\n" }];
    const w = await freshWorkspace("rt-notion-taken");
    await importFiles(w.ws, w.actor, files);
    const again = await importFiles(w.ws, w.actor, files);
    expect(databaseConflicts(again)).toEqual([{ path: "Books.csv", reason: "database_unavailable" }]);
  }, 120_000);
});
