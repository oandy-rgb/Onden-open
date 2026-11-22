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
// A loss that exists today is pinned as `it.fails` with its fix named. One is left: a text attribute whose value is empty
// (`empty-attribute`), which is the owner's call to keep or not (see its entry in helpers/roundTripRichSpec.ts).

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { isTestDatabase } from "../helpers/testDatabase.js";
import { roundTripRuns, worldSpec, type WorldSpec } from "../helpers/roundTripArb.js";
import { buildWorld, freshWorkspace, snapshotWorkspace, type WorldSnapshot } from "../helpers/roundTripWorld.js";
import { fullBackup, restoreBackup } from "../helpers/roundTripApi.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { zipEntries } from "../helpers/zipEntries.js";
import { rawZip } from "../helpers/rawZip.js";
import { seedQ } from "../helpers/seedQ.js";
import { q } from "../../db.js";
import { readApp, appDifferences, APP_PARTS, type AppPart } from "../helpers/roundTripRich.js";
import { RICH_LOSSES, inkValue, minimalWorld, type RichLoss } from "../helpers/roundTripRichSpec.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { workspaceSwitch } from "../helpers/workspaceSwitch.js";
import { stageBackupUpload } from "../../services/backupFile.js";
import { measureFullBackup } from "../../services/backupArchive.js";
import { Readable } from "node:stream";
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
      worldSpec({ trashed: true, exotic: "values", bigInk: true, canvas: true, tagFunctions: true, media: true, linksToTrashed: true, standaloneTasks: true }),
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

  // The whole claim, every part: a restore into another workspace shows what the original showed. The worlds hold something the
  // fixed parts below apply to (views, functions, `extends`, pointers, graph positions), so the property is not green by luck.
  // The one loss that is left, an empty text attribute, is not generated here (`plainValue` is never empty); it is the named case
  // `empty-attribute` below, pinned until the owner decides.
  const lossyPart = (spec: WorldSpec) => {
    const r = spec.rich!;
    return r.tagViews.length + r.noteViews.length + r.functions.length + r.extendsLinks.length + r.pointers.length + r.graph.length > 0;
  };
  it("a restore shows the same views, functions, extends, pointers, graph, paragraph tags, anchors, attributes and ink as the original", async () => {
    await fc.assert(fc.asyncProperty(richWorld().filter(lossyPart), async (spec) => {
      const { before, after } = await appTrip(spec);
      expect(appDifferences(before, after, APP_PARTS)).toEqual({});
    }), roundTripRuns({ maxRuns: 6 }));
  }, 600_000);

  // One minimal, named case per loss (helpers/roundTripRichSpec.ts RICH_LOSSES: scenario, expected, actual, where).
  // Each is a fixed world, so any seed (the default 20261024) shows it.
  // Every loss but `empty-attribute` is fixed and an ordinary test now; that one is the owner's call and stays `it.fails`.
  const RESTORED_NOW = new Set(["tag-views", "note-views", "note-tab-settings", "view-ids-tag", "view-ids-note-tab", "tag-functions", "tag-extends", "tag-functions-inherited", "pointers", "graph-positions"]);
  describe.each(RICH_LOSSES.map((loss: RichLoss) => [loss.id, loss] as const))("loss %s", (_id, loss) => {
    (RESTORED_NOW.has(loss.id) ? it : it.fails)(`FINDING ${loss.id}: ${loss.scenario} ${loss.expected}`, async () => {
      const { before, after } = await appTrip(loss.world);
      expect(appDifferences(before, after, [loss.part])).toEqual({});
    }, 120_000);
  });

  // Compatibility of the sidebar shortcuts (note_pointers), carried in each note's sidecar as `pointers` (the archive version stays 2).
  const shortcutsWorld = () => minimalWorld({ pointers: [{ target: 0, under: 1 }, { target: 1, under: null }] });
  /** The sidecars of `zip` with `change` applied to each note's JSON, the rest of the archive as it was. */
  const withSidecars = (zip: Buffer, change: (note: Record<string, unknown>) => void) => rawZip([...zipEntries(zip)].map(([name, data]) => {
    if (!name.startsWith(".onden/notes/")) return { name, data };
    const note = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    change(note);
    return { name, data: JSON.stringify(note) };
  }));

  it("a backup made before shortcuts were in it (no `pointers` in its notes) still restores, without shortcuts", async () => {
    const a = await freshWorkspace("rt-old-a");
    workspaceSwitch.ws = a.ws;
    await buildWorld(shortcutsWorld(), a);
    const zip = await fullBackup(a.ws, a.actor);
    const holding = [...zipEntries(zip)].filter(([name, data]) => name.startsWith(".onden/notes/") && "pointers" in JSON.parse(data.toString("utf8")));
    expect(holding.length, "the new backup writes shortcuts into the notes they point at").toBe(2);
    const old = withSidecars(zip, (note) => { delete note.pointers; });
    const b = await freshWorkspace("rt-old-b");
    const space = await makeSpace(b.ws, "Restore target", [{ id: b.actor.id, permission: "edit" }]);
    const report = await restoreBackup(b.ws, b.actor, old, space);
    expect(report).toMatchObject({ created: expect.any(Number) });
    workspaceSwitch.ws = b.ws;
    const after = await readApp(b.ws, b.actor);
    expect(after.pointers).toEqual([]);
    expect(after.notes.map((n) => n.title).sort()).toEqual(["Note one", "Note two"]);
  }, 120_000);

  it("a shortcut under a note the backup does not hold is left out of the archive; one at the top of the sidebar is kept", async () => {
    const a = await freshWorkspace("rt-part-pointer");
    const built = await buildWorld(shortcutsWorld(), a);
    // A partial backup of Note one only: its shortcut sits under Note two, which the backup lacks.
    const one = [...zipEntries(await fullBackup(a.ws, a.actor, `note=${built.noteIds[0]}`))].filter(([name]) => name.startsWith(".onden/notes/"))
      .map(([, data]) => JSON.parse(data.toString("utf8")) as { title: string; pointers?: unknown[] }).find((n) => n.title === "Note one")!;
    expect(one.pointers).toBeUndefined();
    const two = [...zipEntries(await fullBackup(a.ws, a.actor, `note=${built.noteIds[1]}`))].filter(([name]) => name.startsWith(".onden/notes/"))
      .map(([, data]) => JSON.parse(data.toString("utf8")) as { title: string; pointers?: Array<{ parent_id: string | null }> }).find((n) => n.title === "Note two")!;
    expect(two.pointers!.map((p) => p.parent_id)).toEqual([null]);
  }, 120_000);

  // A paragraph with a block tag (`{idea}`) is still listed on its tag page. (An earlier version of this comment named a difference in
  // a larger world: the restored tag page listed a paragraph the original's did not. It was the test's own model, reduced to the
  // fixed case below: the generator wrote `text {idea} ^id`, a typed `^id` AFTER the tag. A normal read does not see that old
  // mark, so `{idea}` is not at the end of the line and the original lists nothing; a restore turns the typed id into an anchor
  // and the text becomes `text {idea}`, which lists. Not a loss, and the generator no longer combines the two.)
  it.each([["tagged first", ["idea"]]] as const)("a paragraph block tag is listed on its tag page after a restore (%s)", async (_name, [tag]) => {
    const { before, after } = await appTrip(minimalWorld({}, tag));
    expect(appDifferences(before, after, ["blockTags", "anchors"])).toEqual({});
  }, 120_000);

  // Current behaviour, pinned so that a change shows: a paragraph written `text {idea} ^id` (the old typed id after the tag) is not on
  // the tag page of the original, and is on the restored one, because the restore moves the id out of the text into an anchor. The id
  // itself is kept (the same anchors before and after).
  it("a typed ^id after a block tag hides the tag until the restore moves the id into an anchor (current behaviour)", async () => {
    const world = minimalWorld({}, "idea");
    world.notes[0]!.blocks = [{ kind: "paragraph", text: "段落", ref: "abc123", tag: "idea" }];
    const { before, after } = await appTrip(world);
    expect(before.tags.find((t) => t.path === "idea")!.blocks, "original").toEqual([]);
    expect(after.tags.find((t) => t.path === "idea")!.blocks, "restored").toEqual([{ note: "Note one", label: "段落" }]);
    expect(appDifferences(before, after, ["anchors"])).toEqual({});
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

  // Scan 14 #7. A partial backup (`note=`) records only the links between notes it holds; a restore must not delete the
  // links the restored note's text has to a note that is not in the backup. A `[[title]]` resolves inside the note's own
  // space, so the notes outside the backup must be in the space restored into: the backed-up notes are removed for good
  // from their own workspace and the backup is merged back (a session written elsewhere, brought home).
  // Property: the links from the restored notes to notes outside the backup are the same as before the notes were removed.
  const outsideLinks = async (ws: string, titles: string[]) => (await q<{ pair: string }>(
    `SELECT s.title || ' → ' || t.title AS pair FROM node_edges e
       JOIN content_nodes s ON s.id = e.source_node_id JOIN content_nodes t ON t.id = e.target_node_id
      WHERE e.workspace_id = $1 AND e.origin = 'wikilink' AND s.title = ANY($2::text[]) AND NOT (t.title = ANY($2::text[])) AND t.deleted_at IS NULL
      ORDER BY 1`, [ws, titles])).rows.map((r) => r.pair);

  /** Back up the flat live notes picked by `flips` as a partial backup, remove them from their workspace and merge the backup back. */
  async function partialBackupHome(spec: WorldSpec, flips: boolean[]) {
    const a = await freshWorkspace("rt-part");
    const built = await buildWorld(spec, a);
    const hasChild = (i: number) => spec.notes.some((n) => n.parent === i);
    const picked = spec.notes.map((n, i) => !n.trashed && n.parent === null && !hasChild(i) && !!flips[i % flips.length]);
    const titles = spec.notes.filter((_n, i) => picked[i]).map((n) => n.title);
    const before = await outsideLinks(a.ws, titles);
    const zip = await fullBackup(a.ws, a.actor, spec.notes.flatMap((_n, i) => (picked[i] ? [`note=${built.noteIds[i]}`] : [])).join("&"));
    const ids = spec.notes.flatMap((_n, i) => (picked[i] ? [built.noteIds[i]!] : []));
    const kept = spec.notes.findIndex((n, i) => !picked[i] && !n.trashed);
    const space = kept < 0 ? null : (await q<{ space_id: string }>(`SELECT space_id::text FROM content_nodes WHERE id = $1`, [built.noteIds[kept]])).rows[0]!.space_id;
    return { a, titles, before, zip, ids, space };
  }

  it("a partial backup merged back keeps the links that point outside the backup", async () => {
    const worth = (s: WorldSpec) => s.notes.some((n) => !n.trashed && n.blocks.some((b) => b.kind === "link" && b.via === "wikilink"));
    await fc.assert(fc.asyncProperty(worldSpec({ maxNotes: 5 }).filter(worth), fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }), async (spec, flips) => {
      const { a, titles, before, zip, ids, space } = await partialBackupHome(spec, flips);
      if (before.length === 0 || space === null) return;
      await seedQ(`DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`, [ids]);
      await restoreBackup(a.ws, a.actor, zip, space, "merge");
      expect(await outsideLinks(a.ws, titles)).toEqual(before);
    }), roundTripRuns({ maxRuns: 8 }));
  }, 600_000);

  it("a note merged back from a partial backup is still linked to the note outside it (fixed case)", async () => {
    const note = (title: string, blocks: WorldSpec["notes"][number]["blocks"]) => ({ title, parent: null, blocks, tags: [], attrs: [], trashed: false, media: false });
    const { a, before, zip, ids, space } = await partialBackupHome({ tags: [], canvas: null, notes: [note("Algorithms", []), note("Session", [{ kind: "link", target: 0, alias: null, via: "wikilink" }])] }, [false, true]);
    expect(before).toEqual(["Session → Algorithms"]);
    await seedQ(`DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`, [ids]);
    await restoreBackup(a.ws, a.actor, zip, space!, "merge");
    expect(await outsideLinks(a.ws, ["Session"])).toEqual(["Session → Algorithms"]);
  }, 120_000);

  // Review of the fix above: the link step must not grow a query with the size of the restore (a Postgres query takes at most
  // 65,535 parameters; a 16 GB backup holds more notes than that). Fixed case: a restore of 70,000 notes' ids in one call.
  it("the link step works when the restore made more notes than one query may name", async () => {
    const note = (title: string, blocks: WorldSpec["notes"][number]["blocks"]) => ({ title, parent: null, blocks, tags: [], attrs: [], trashed: false, media: false });
    const a = await freshWorkspace("rt-part-many");
    const built = await buildWorld({ tags: [], canvas: null, notes: [note("Inside", []), note("Outside", []), note("Source", [
      { kind: "link", target: 0, alias: null, via: "wikilink" }, { kind: "link", target: 1, alias: null, via: "wikilink" }])] }, a);
    const { settleWikilinkEdges } = await import("../../services/backupLinks.js");
    const [inside, , source] = built.noteIds as [string, string, string];
    const many = new Set([inside, source, ...Array.from({ length: 70_000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)]);
    const { withTransaction } = await import("../../db.js");
    await withTransaction(() => settleWikilinkEdges(a.ws, [{ id: source, deleted: false, targets: [] }], many));
    // `Inside` is among the restored notes and the backup recorded no link to it: gone. `Outside` is not: kept.
    expect(await outsideLinks(a.ws, ["Source"])).toEqual(["Source → Outside"]);
  }, 120_000);
});
