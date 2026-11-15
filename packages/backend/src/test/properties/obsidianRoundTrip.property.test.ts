// Round trip 2: an Obsidian-shaped vault → import → export → import.
//
// fast-check generates a workspace (helpers/roundTripArb.ts) and
// helpers/roundTripVault.ts lays it out as an Obsidian vault (folders, folder
// notes, frontmatter, wikilinks, embeds, `^ref` anchors, pictures). The vault
// is imported into one empty workspace (A), A is exported, and the zip is
// imported into another (B). What the vault said must be in A, and A must come
// through the Markdown trip as test/properties/exportImportRoundTrip does.
// Replay a failing vault with ROUNDTRIP_SEED=<seed>.

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { roundTripRuns, worldSpec } from "../helpers/roundTripArb.js";
import { freshWorkspace, snapshotWorkspace } from "../helpers/roundTripWorld.js";
import { exportMarkdown, importFiles, zipFiles } from "../helpers/roundTripApi.js";
import { vaultOf } from "../helpers/roundTripVault.js";
import { expectNotesSurvive, expectSameExport, liveNotes } from "../helpers/roundTripCompare.js";

vi.mock("../../db.js", async (original) => {
  const { workspaceSwitch } = await import("../helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});

const enabled = isTestDatabase();

describe.skipIf(!enabled)("Obsidian vault → import → export → import", () => {
  it("the vault's notes, folders, tags, properties and links are what the workspace holds, and survive the trip", async () => {
    await fc.assert(fc.asyncProperty(worldSpec({ media: true }), async (spec) => {
      const vault = await vaultOf(spec);
      const a = await freshWorkspace("rt-vault-a");
      const report = await importFiles(a.ws, a.actor, vault.files);
      expect(report.skipped, JSON.stringify(report.conflicts)).toBe(0);
      expect(report.imported).toBe(spec.notes.length);
      const imported = await snapshotWorkspace(a.ws);

      // 1. What the vault said is in the workspace.
      expect(liveNotes(imported).map((n) => n.title).sort()).toEqual([...vault.names].sort());
      for (const [i, note] of spec.notes.entries()) {
        const got = imported.notes.find((n) => n.title === vault.names[i])!;
        expect(got.parent, `folder of ${vault.names[i]}`).toBe(note.parent === null ? null : vault.names[note.parent]);
        for (const attr of note.attrs) expect(got.attributes[attr.key]?.value, `${vault.names[i]}.${attr.key}`).toBe(attr.value);
        expect(got.tags.length, `tags of ${vault.names[i]}`).toBe(new Set(note.tags.map((t) => spec.tags[t]!)).size);
      }

      // 2. The workspace goes out and comes back as it is.
      const zip = await exportMarkdown(a.ws, a.actor);
      const b = await freshWorkspace("rt-vault-b");
      const second = await importFiles(b.ws, b.actor, zipFiles(zip));
      expect(second.skipped, JSON.stringify(second.conflicts)).toBe(0);
      expectNotesSurvive(imported, await snapshotWorkspace(b.ws), zip);
      expectSameExport(zip, await exportMarkdown(b.ws, b.actor));
    }), roundTripRuns());
  }, 300_000);
});
