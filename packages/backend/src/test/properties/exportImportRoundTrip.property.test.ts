// Round trip 1: Markdown export → import into an empty workspace, then export
// again (docs/architecture/… none; contract: services/exportZip.ts and
// modules/importers/markdown/note.ts).
//
// fast-check generates realistic workspaces (helpers/roundTripArb.ts), the
// test builds one in a workspace of its own, exports it through
// GET /api/export/markdown.zip, imports the zip into another empty workspace
// through POST /api/import/obsidian, and compares the two (helpers/
// roundTripWorld.ts snapshotWorkspace). Replay a failing world with
// ROUNDTRIP_SEED=<seed> (printed by fast-check).
//
// A test marked `it.fails` would pin a loss that exists today and go red once
// it is fixed, which is the cue to drop the `.fails`; none is left here.

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { roundTripRuns, worldSpec, type WorldSpec } from "../helpers/roundTripArb.js";
import { buildWorld, freshWorkspace, snapshotWorkspace } from "../helpers/roundTripWorld.js";
import { exportMarkdown, importFiles, zipFiles } from "../helpers/roundTripApi.js";
import { danglingLinks, expectNotesSurvive, expectSameExport, fileTitle, liveNotes, noteFiles } from "../helpers/roundTripCompare.js";
import { seedQ } from "../helpers/seedQ.js";


vi.mock("../../db.js", async (original) => {
  const { workspaceSwitch } = await import("../helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});

const enabled = isTestDatabase();

/** Build `spec`, export it, import the zip into an empty workspace. */
async function trip(spec: WorldSpec) {
  const a = await freshWorkspace("rt-a");
  const built = await buildWorld(spec, a);
  const before = await snapshotWorkspace(a.ws);
  const zip = await exportMarkdown(a.ws, a.actor);
  const b = await freshWorkspace("rt-b");
  // A world whose notes are all in the trash exports nothing; the import
  // refuses an empty file list, so there is nothing to bring back.
  const report = zip.size > 0 ? await importFiles(b.ws, b.actor, zipFiles(zip)) : { imported: 0, skipped: 0, conflicts: [] };
  const after = await snapshotWorkspace(b.ws);
  return { a, b, built, before, zip, report, after };
}

// An export names a note's file in its `aliases` when the file name is not its title (a `:` or a
// duplicate title): `without` drops that alias the note did not start with.
const valuesOf = (attributes: Record<string, { value: string }>, without: string[] = []) =>
  Object.fromEntries(Object.entries(attributes).filter(([k]) => !without.includes(k)).map(([k, v]) => [k, v.value]));

describe("the generated worlds", () => {
  it("reach every kind of content a round trip must carry", () => {
    const specs = fc.sample(worldSpec({ trashed: true, exotic: true, canvas: true, tagFunctions: true, media: true, linksToTrashed: true }), { numRuns: 150, seed: 1 });
    const kinds = new Set(specs.flatMap((s) => s.notes.flatMap((n) => n.blocks.map((b) => b.kind === "link" ? `link:${b.via}` : b.kind))));
    for (const kind of ["paragraph", "heading", "list", "task", "code", "math", "image", "quote", "link:wikilink", "link:node", "embed", "blockLink"]) expect(kinds, kind).toContain(kind);
    expect(specs.some((s) => s.notes.some((n) => n.blocks.some((b) => b.kind === "paragraph" && b.ref)))).toBe(true);
    expect(specs.some((s) => s.notes.some((n) => n.trashed)) && specs.some((s) => s.notes.some((n) => !n.trashed))).toBe(true);
    expect(specs.some((s) => s.tags.some((t) => t.parent !== null))).toBe(true);
    expect(specs.some((s) => s.tags.some((t) => t.functions))).toBe(true);
    expect(specs.some((s) => s.notes.some((n) => n.media))).toBe(true);
    expect(specs.some((s) => s.notes.some((n) => n.attrs.some((a) => a.key.includes(" ") || a.value.includes("\n"))))).toBe(true);
    expect(specs.some((s) => s.canvas && s.canvas.cards.length > 0)).toBe(true);
    expect(specs.some((s) => s.notes.some((n) => n.title.includes("/")))).toBe(true);
  });
});

describe.skipIf(!enabled)("Markdown export → import into an empty workspace", () => {
  it("keeps titles, bodies, tree, tags, attributes, links and block references", async () => {
    await fc.assert(fc.asyncProperty(worldSpec({ trashed: true, media: true, canvas: true, tagFunctions: true }), async (spec) => {
      const { before, zip, report, after } = await trip(spec);
      expect(report.skipped, JSON.stringify(report.conflicts)).toBe(0);

      expectNotesSurvive(before, after, zip);
    }), roundTripRuns());
  }, 300_000);

  it("a second export equals the first, apart from the id and updated_at lines", async () => {
    await fc.assert(fc.asyncProperty(worldSpec({ trashed: true, media: true }), async (spec) => {
      const { b, zip } = await trip(spec);
      const again = await exportMarkdown(b.ws, b.actor);
      expectSameExport(zip, again);
    }), roundTripRuns());
  }, 300_000);

  // A tag page with no text is not written (its tag travels in each note's
  // frontmatter): the import would make it a plain note titled like the tag,
  // and a second export would hold both `tag-x.md` and `x.md`.
  it("an empty tag page is not exported, so the workspace gains no notes", async () => {
    await fc.assert(fc.asyncProperty(worldSpec({ maxNotes: 3 }).filter((s) => s.tags.length > 0), async (spec) => {
      const { before, after } = await trip(spec);
      expect(after.notes.map((n) => n.title).sort()).toEqual(liveNotes(before).map((n) => n.title).sort());
    }), roundTripRuns({ maxRuns: 4 }));
  }, 300_000);

  // KNOWN: review #10 — fix/a2-structure-import-backup. exportedNoteFile
  // leaves out an attribute whose key is outside the key grammar ("Due Date",
  // a colon, an emoji) and one whose value has a newline, and says nothing.
  it("KNOWN #10 (fix/a2-structure-import-backup): attributes with odd keys or multi-line values survive", async () => {
    const hasExotic = (s: WorldSpec) => s.notes.some((n) => !n.trashed && n.attrs.some((a) => !/^[\p{L}_][\p{L}\p{M}\p{N}_-]*$/u.test(a.key) || a.value.includes("\n")));
    await fc.assert(fc.asyncProperty(worldSpec({ maxNotes: 3, exotic: true }).filter(hasExotic), async (spec) => {
      const { before, after } = await trip(spec);
      for (const want of liveNotes(before)) {
        const got = after.notes.find((n) => n.title === want.title)!;
        expect(valuesOf(got.attributes, "aliases" in want.attributes ? [] : ["aliases"]), `attributes of ${want.title}`).toEqual(valuesOf(want.attributes));
      }
    }), roundTripRuns({ maxRuns: 4 }));
  }, 300_000);

  // KNOWN: review #23 — fix/a2-structure-import-backup. A note link to a note
  // the export leaves out (one in the trash) is written as `./<uuid>.md`, a
  // file that is not in the archive.
  it("KNOWN #23 (fix/a2-structure-import-backup): no exported link points at a file that is not in the archive", async () => {
    const linksToTrashed = (s: WorldSpec) => s.notes.some((n) => !n.trashed && n.blocks.some((b) => b.kind === "link" && b.via === "node" && s.notes[b.target]!.trashed));
    await fc.assert(fc.asyncProperty(worldSpec({ maxNotes: 4, trashed: true, linksToTrashed: true }).filter(linksToTrashed), async (spec) => {
      const a = await freshWorkspace("rt-a");
      await buildWorld(spec, a);
      expect(danglingLinks(await exportMarkdown(a.ws, a.actor))).toEqual([]);
    }), roundTripRuns({ maxRuns: 4 }));
  }, 300_000);

  // KNOWN: review #23 — fix/a2-structure-import-backup. fullTagPath stops at
  // a deleted ancestor, so a tag under one is exported with a shorter path and
  // comes back as a root tag.
  it("KNOWN #23 (fix/a2-structure-import-backup): a tag under a deleted tag keeps its full path", async () => {
    const a = await freshWorkspace("rt-a");
    const spec: WorldSpec = {
      tags: [{ name: "projects", parent: null, functions: false }, { name: "school", parent: 0, functions: false }, { name: "algorithms", parent: 1, functions: false }],
      notes: [{ title: "Sorting", parent: null, blocks: [], tags: [2], attrs: [], trashed: false, media: false }], canvas: null,
    };
    const built = await buildWorld(spec, a);
    // The middle tag is deleted (merged away, or removed by a person).
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [built.tagIds[1]]);
    const zip = await exportMarkdown(a.ws, a.actor);
    const file = noteFiles(zip).find(([, data]) => fileTitle(data.toString("utf8")) === "Sorting")![1].toString("utf8");
    expect(file).toContain("projects/school/algorithms");
  }, 120_000);

  // The export leaves some of the workspace out on purpose (notes in the
  // trash, canvases, a tag's fields and colour), which is fine, but says
  // nothing about it: the archive holds the notes and their attachments and
  // no other entry. The contract asked for: what is left out is reported.
  it("the export reports what it leaves out (trash, canvases, tag functions)", async () => {
    const leavesSomethingOut = (s: WorldSpec) => s.notes.some((n) => n.trashed) || (s.canvas?.cards.length ?? 0) > 0 || s.tags.some((t) => t.functions);
    await fc.assert(fc.asyncProperty(worldSpec({ maxNotes: 4, trashed: true, canvas: true, tagFunctions: true }).filter(leavesSomethingOut), async (spec) => {
      const a = await freshWorkspace("rt-a");
      await buildWorld(spec, a);
      const zip = await exportMarkdown(a.ws, a.actor);
      const other = [...zip.keys()].filter((name) => !name.endsWith(".md") && !name.startsWith("attachments/"));
      expect(other, "an entry that lists what was left out").not.toEqual([]);
    }), roundTripRuns({ maxRuns: 4 }));
  }, 300_000);
});
