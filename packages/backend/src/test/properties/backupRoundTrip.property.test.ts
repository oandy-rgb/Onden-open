// Round trip 3: the app's own backup (GET /api/backup/full.zip) → restore into
// an empty workspace of its own.
//
// fast-check generates a workspace (helpers/roundTripArb.ts: tree, trashed
// notes, tags with fields, odd attribute keys and multi-line values, media, a
// canvas), the test builds it, takes a backup, and restores it through the
// upload → apply routes into a second, empty workspace. Both are read back
// with snapshotWorkspace and compared whole: titles, bodies (links and media
// by what they name), tree, trash, attributes, tasks, links, block references,
// canvases and their cards, tag definitions and which notes carry them. The
// worlds include standalone tasks (no host note: body, status, 何時做, 截止,
// repeat, evening / someday, reminder), live and in the trash.
//
// A restore into another workspace gives every note and tag a new id, so a
// snapshot (keyed by title) is what is compared. Replay a failing world with
// ROUNDTRIP_SEED=<seed>.
//
// A loss that exists today is pinned as `it.fails` with its fix named; none is left.

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { isTestDatabase } from "../helpers/testDatabase.js";
import { roundTripRuns, worldSpec, type WorldSpec } from "../helpers/roundTripArb.js";
import { buildWorld, freshWorkspace, snapshotWorkspace, type WorldSnapshot } from "../helpers/roundTripWorld.js";
import { fullBackup, restoreBackup } from "../helpers/roundTripApi.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { zipEntries } from "../helpers/zipEntries.js";
import { seedQ } from "../helpers/seedQ.js";
import { readApp, appDifferences, APP_PARTS, type AppPart } from "../helpers/roundTripRich.js";
import { RICH_LOSSES, inkValue, minimalWorld, type RichLoss } from "../helpers/roundTripRichSpec.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { workspaceSwitch } from "../helpers/workspaceSwitch.js";
import { stageBackupUpload } from "../../services/backupFile.js";
import { measureFullBackup } from "../../services/backupArchive.js";
import { Readable } from "node:stream";
import { q } from "../../db.js";
import { setNodeAttribute } from "../../services/attributeWrites.js";

registerShippedModules();

vi.mock("../../db.js", async (original) => {
  const { workspaceSwitch } = await import("../helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});

const enabled = isTestDatabase();

/** Build `spec`, back it up and restore the backup into an empty workspace. */
async function backupTrip(spec: WorldSpec) {
  const a = await freshWorkspace("rt-backup-a");
  const built = await buildWorld(spec, a);
  const before = await snapshotWorkspace(a.ws);
  const zip = await fullBackup(a.ws, a.actor);
  const b = await freshWorkspace("rt-backup-b");
  const space = await makeSpace(b.ws, "Restore target", [{ id: b.actor.id, permission: "edit" }]);
  const report = await restoreBackup(b.ws, b.actor, zip, space);
  const after = await snapshotWorkspace(b.ws);
  return { a, b, built, before, zip, report, after };
}

/** The snapshot without the tag memberships and tag definitions (see the
 *  KNOWN failure for why they are compared on their own). */
const withoutTags = (s: WorldSnapshot): WorldSnapshot => ({ ...s, tags: [], notes: s.notes.map((n) => ({ ...n, tags: [] })) });

describe.skipIf(!enabled)("backup → restore into an empty workspace", () => {
  it("brings back every note, the trash, attributes, tasks, links, canvases and media references", async () => {
    await fc.assert(fc.asyncProperty(
      worldSpec({ trashed: true, exotic: "values", canvas: true, tagFunctions: true, media: true, linksToTrashed: true, standaloneTasks: true }),
      async (spec) => {
        const { before, after, report } = await backupTrip(spec);
        expect(report, "restore report").toMatchObject({ created: expect.any(Number) });
        const want = withoutTags(before), got = withoutTags(after);
        expect(got.notes.map((n) => [n.title, n.parent, n.deleted])).toEqual(want.notes.map((n) => [n.title, n.parent, n.deleted]));
        expect(got.notes).toEqual(want.notes);
        expect(got.tasks).toEqual(want.tasks);
        expect(got.tasks.filter((t) => t.host === null).length, "standalone tasks").toBe(spec.tasks?.length ?? 0);
        expect(got.canvases).toEqual(want.canvases);
      },
    ), roundTripRuns());
  }, 300_000);

  // KNOWN: review #6 — fix/a2-structure-import-backup. backupRestore.ts judges
  // a backup's tag "already there" from a row of any workspace (`taken` is
  // looked up by id alone), so restoring into another workspace neither
  // creates the tags nor maps them by path, and every tag application is
  // skipped. The notes come back without their tags, and the tag tree,
  // fields and colours are missing.
  it("KNOWN #6 (fix/a2-structure-import-backup): tags, their tree and fields, and who carries them, survive a restore into another workspace", async () => {
    const tagged = (s: WorldSpec) => s.notes.some((n) => n.tags.length > 0);
    await fc.assert(fc.asyncProperty(worldSpec({ maxNotes: 4, tagFunctions: true }).filter(tagged), async (spec) => {
      const { before, after } = await backupTrip(spec);
      expect(after.tags).toEqual(before.tags);
      expect(after.notes.map((n) => [n.title, n.tags])).toEqual(before.notes.map((n) => [n.title, n.tags]));
    }), roundTripRuns({ maxRuns: 4 }));
  }, 300_000);

  // The backup archive keeps an attribute whose key is outside the key
  // grammar ("Due Date", a colon, an emoji: how a CSV column is stored); the
  // restore writes it back as an existing key, not as a new odd one.
  it("a restore brings back attributes whose key is outside the key grammar", async () => {
    const odd = (s: WorldSpec) => s.notes.some((n) => n.attrs.some((a) => /[^\p{L}\p{M}\p{N}_-]/u.test(a.key)));
    await fc.assert(fc.asyncProperty(worldSpec({ maxNotes: 3, exotic: true }).filter(odd), async (spec) => {
      const { before, after } = await backupTrip(spec);
      expect(after.notes.map((n) => [n.title, n.attributes])).toEqual(before.notes.map((n) => [n.title, n.attributes]));
    }), roundTripRuns({ maxRuns: 4 }));
  }, 300_000);

  // KNOWN: review #23 — fix/a2-structure-import-backup. A deleted note's file
  // goes to `.trash/<its stored slug>` as it is (safeBase, not vaultName), so
  // a slug from before slugs were cleaned ("old/slug", "../x") makes a nested
  // path, or one that leaves the archive; the restore refuses such an entry
  // (unsafe_entry), so the backup cannot be restored.
  it("KNOWN #23 (fix/a2-structure-import-backup): a trashed note whose old slug holds a slash or .. is a flat, safe .trash file", async () => {
    const a = await freshWorkspace("rt-backup-a");
    const spec: WorldSpec = {
      tags: [], canvas: null,
      notes: [
        { title: "Slash", parent: null, blocks: [], tags: [], attrs: [], trashed: true, media: false },
        { title: "Dots", parent: null, blocks: [], tags: [], attrs: [], trashed: true, media: false },
      ],
    };
    const built = await buildWorld(spec, a);
    await seedQ(`UPDATE content_nodes SET slug = 'old/slug' WHERE id = $1`, [built.noteIds[0]]);
    await seedQ(`UPDATE content_nodes SET slug = '../../escape' WHERE id = $1`, [built.noteIds[1]]);
    const zip = zipEntries(await fullBackup(a.ws, a.actor));
    const trashFiles = [...zip.keys()].filter((name) => name.endsWith(".md") && !name.startsWith(".onden/"));
    for (const name of trashFiles) {
      expect(name.split("/").filter((s) => s === ".." || s === ""), `entry ${name}`).toEqual([]);
      expect(name.match(/^\.trash\/[^/]+\.md$/), `entry ${name} is a flat .trash file`).not.toBeNull();
    }
    const b = await freshWorkspace("rt-backup-b");
    const space = await makeSpace(b.ws, "Restore target", [{ id: b.actor.id, permission: "edit" }]);
    await restoreBackup(b.ws, b.actor, await fullBackup(a.ws, a.actor), space);
  }, 120_000);

  // ── What a person sees: saved views, functions, pointers, paragraph tags, graph, typed and ink attributes ──────────
  // Read through the sync bootstrap, the view lists, the tag block list and the function lists (helpers/roundTripRich.ts
  // readApp), never by table rows. An ordinary restore (mode "empty") does not carry the person's own review progress,
  // settings or subscriptions (backupExtras.ts: only a workspace move does); backupHostHop.property.test.ts compares those.
  const richWorld = (extra: Parameters<typeof worldSpec>[0] = {}) => worldSpec({ maxNotes: 5, trashed: true, tagFunctions: true, canvas: true, rich: true, ...extra });

  /** Build `spec`, back it up, restore into an empty space; what the app shows before and after. */
  async function appTrip(spec: WorldSpec) {
    const a = await freshWorkspace("rt-app-a");
    workspaceSwitch.ws = a.ws;
    await buildWorld(spec, a);
    const before = await readApp(a.ws, a.actor);
    const zip = await fullBackup(a.ws, a.actor);
    const b = await freshWorkspace("rt-app-b");
    const space = await makeSpace(b.ws, "Restore target", [{ id: b.actor.id, permission: "edit" }]);
    await restoreBackup(b.ws, b.actor, zip, space);
    workspaceSwitch.ws = b.ws;
    return { before, after: await readApp(b.ws, b.actor) };
  }

  // The parts that come back today. Attributes of every type (text, number, date, bool, a link to a note) and ink in all
  // three attribute keys (ink_data, board_ink, note_ink: strokes only, shapes only, both).
  const SURVIVING: AppPart[] = ["attributes", "ink"];
  it("a restore shows the same typed attributes and ink (stroke and shape layers) as the original", async () => {
    await fc.assert(fc.asyncProperty(richWorld(), async (spec) => {
      const { before, after } = await appTrip(spec);
      expect(appDifferences(before, after, SURVIVING)).toEqual({});
    }), roundTripRuns({ maxRuns: 6 }));
  }, 600_000);

  // Scan 08 #1/#2 beside the board export: the board's pen layer (board_ink), a note's handwriting page (ink_data) and
  // its 手寫 tab (note_ink) are three drawings of one note. Each comes back under its own key, whatever it holds
  // (strokes only, shapes only, both, an empty layer) and when one note holds all three.
  it.each([
    ["board shapes only, page strokes only, tab both", [{ key: "board_ink", strokes: 0, shapes: 2, salt: 1 }, { key: "ink_data", strokes: 3, shapes: 0, salt: 2 }, { key: "note_ink", strokes: 1, shapes: 1, salt: 3 }]],
    ["board strokes only, page shapes only, tab empty", [{ key: "board_ink", strokes: 2, shapes: 0, salt: 4 }, { key: "ink_data", strokes: 0, shapes: 1, salt: 5 }, { key: "note_ink", strokes: 0, shapes: 0, salt: 6 }]],
    ["board empty layer, page both, tab shapes only", [{ key: "board_ink", strokes: 0, shapes: 0, salt: 7 }, { key: "ink_data", strokes: 2, shapes: 2, salt: 8 }, { key: "note_ink", strokes: 0, shapes: 2, salt: 9 }]],
  ] as const)("a note that holds all three drawings gets each back under its own key (%s)", async (_name, inks) => {
    const world = minimalWorld({ attrs: [{ note: 0, kind: "inkset", inks: [...inks] as never }, { note: 1, kind: "ink", ink: { key: "board_ink", strokes: 1, shapes: 1, salt: 10 } }] });
    const { before, after } = await appTrip(world);
    expect(appDifferences(before, after, ["ink"])).toEqual({});
    const kept = after.notes.find((n) => n.title === "Note one")!.attributes.filter((x) => ["ink_data", "board_ink", "note_ink"].includes(x.key)).map((x) => x.key).sort();
    expect(kept).toEqual(["board_ink", "ink_data", "note_ink"]);
  }, 120_000);

  // A board on a tag page keeps its pen layer on the tag itself (boardStore: a tag's board is keyed by the tag).
  it("a tag page's board keeps its pen layer (shapes only) under board_ink after a restore, and no handwriting page appears", async () => {
    const a = await freshWorkspace("rt-tagboard-a");
    workspaceSwitch.ws = a.ws;
    const built = await buildWorld(minimalWorld({}), a);
    const tagId = built.tagIds[0]!;
    const layer = inkValue({ key: "board_ink", strokes: 0, shapes: 2, salt: 42 });
    await setNodeAttribute({ workspaceId: a.ws, actor: a.actor, nodeId: tagId, attribute: { key: "board_ink", value: layer, value_type: "text" } as never });
    const zip = await fullBackup(a.ws, a.actor);
    const b = await freshWorkspace("rt-tagboard-b");
    const space = await makeSpace(b.ws, "Restore target", [{ id: b.actor.id, permission: "edit" }]);
    await restoreBackup(b.ws, b.actor, zip, space);
    const restored = (await q<{ key: string; value: string }>(
      `SELECT a.key, a.value FROM node_attributes a JOIN content_nodes n ON n.id = a.node_id
        WHERE n.workspace_id = $1 AND n.node_type = 'class_tag' AND n.title = 'Alpha' AND a.key IN ('board_ink', 'ink_data', 'note_ink')`, [b.ws])).rows;
    expect(restored.map((r) => r.key)).toEqual(["board_ink"]);
    expect(restored[0]!.value).toBe(layer);
  }, 120_000);

  // The whole claim, every part: pinned while the named losses below exist. Only worlds that hold something a loss
  // applies to are generated, so the property is not green by luck; when the last loss is fixed it turns red: delete `.fails`.
  const lossyPart = (spec: WorldSpec) => {
    const r = spec.rich!;
    return r.tagViews.length + r.noteViews.length + r.functions.length + r.extendsLinks.length + r.pointers.length + r.graph.length > 0;
  };
  // What was lost in a restore into another workspace and is fixed: saved views (every layout, on tags and notes, with the ids
  // their filters and board tabs name), the functions a tag provides, and `extends`. An ordinary test: a missing one, or one that
  // still holds an old id, fails it. The pointers and graph positions are still in the pinned property above.
  const RESTORED_PARTS: AppPart[] = ["tagViews", "noteViews", "noteTabs", "tagFunctions", "tagExtends"];
  const holdsRestoredPart = (spec: WorldSpec) => spec.rich!.tagViews.length + spec.rich!.noteViews.length + spec.rich!.functions.length + spec.rich!.extendsLinks.length > 0;
  it("a restore shows the same views (ids inside them too), tag functions and extends as the original", async () => {
    await fc.assert(fc.asyncProperty(richWorld().filter(holdsRestoredPart), async (spec) => {
      const { before, after } = await appTrip(spec);
      expect(appDifferences(before, after, RESTORED_PARTS)).toEqual({});
    }), roundTripRuns({ maxRuns: 8 }));
  }, 600_000);

  it.fails("FINDING backup-app-parts: a restore shows the same views, functions, extends, pointers, graph, paragraph tags and anchors as the original", async () => {
    await fc.assert(fc.asyncProperty(richWorld().filter(lossyPart), async (spec) => {
      const { before, after } = await appTrip(spec);
      expect(appDifferences(before, after, APP_PARTS)).toEqual({});
    }), roundTripRuns({ maxRuns: 6 }));
  }, 600_000);

  // One minimal, named case per loss (helpers/roundTripRichSpec.ts RICH_LOSSES: scenario, expected, actual, where).
  // Each is a fixed world, so any seed (the default 20261024) shows it.
  // The saved views of tags and notes and the note tabs' settings come back since the restore writes them: ordinary tests now.
  const RESTORED_NOW = new Set(["tag-views", "note-views", "note-tab-settings", "view-ids-tag", "view-ids-note-tab", "tag-functions", "tag-extends", "tag-functions-inherited"]);
  describe.each(RICH_LOSSES.map((loss: RichLoss) => [loss.id, loss] as const))("loss %s", (_id, loss) => {
    (RESTORED_NOW.has(loss.id) ? it : it.fails)(`FINDING ${loss.id}: ${loss.scenario} ${loss.expected}`, async () => {
      const { before, after } = await appTrip(loss.world);
      expect(appDifferences(before, after, [loss.part])).toEqual({});
    }, 120_000);
  });

  // A paragraph with a block tag (`{idea}`) is still listed on its tag page. Passing for the small worlds below; the random
  // property above finds a difference in blockTags in a larger world (a tag tree of five, paragraphs, links: the tag page of
  // the RESTORED workspace lists a paragraph the original's does not, ROUNDTRIP seed 4 in the first run of this file's
  // development, not reduced further) — so "blockTags" is in the pinned FINDING, not in the surviving parts.
  it.each([["tagged first", ["idea"]]] as const)("a paragraph block tag is listed on its tag page after a restore (%s)", async (_name, [tag]) => {
    const { before, after } = await appTrip(minimalWorld({}, tag));
    expect(appDifferences(before, after, ["blockTags", "anchors"])).toEqual({});
  }, 120_000);

  // A backup over what this server restores is still downloaded (it may be restored on a server that allows more); the page
  // says so first. What it compares is /api/backup/size against /api/backup/restore/limit (backupRestore.integration.test.ts and
  // frontend backupLimits.test.tsx pin both ends). Here: the size is known before any download, and an archive larger than the
  // cap staging is given is refused as too large, with nothing left on disk.
  it("a backup is measured before it is downloaded, and an upload past the cap is refused as too large", async () => {
    const a = await freshWorkspace("rt-cap");
    await buildWorld({ tags: [], canvas: null, notes: [{ title: "Big", parent: null, blocks: [{ kind: "paragraph", text: "文字".repeat(200), ref: null }], tags: [], attrs: [], trashed: false, media: true }] }, a);
    workspaceSwitch.ws = a.ws;
    expect((await measureFullBackup(a.actor, a.ws)).bytes).toBeGreaterThan(0);
    const zip = await fullBackup(a.ws, a.actor);
    await expect(stageBackupUpload(a.actor.id, Readable.from([zip]), zip.length, { maxBytes: zip.length - 1 })).rejects.toMatchObject({ code: "backup_too_large" });
  }, 120_000);
});
