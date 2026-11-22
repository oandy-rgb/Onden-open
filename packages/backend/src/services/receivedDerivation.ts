// What a node derives from the rows another node's change bundle wrote here (docs/architecture/proposals/own-node-transport-2026-11-22.md §2.12, batch 4a): the
// finishing step of spine/stampedImport.ts applyChangeBundle, in its transaction, once every row of the bundle is in (spine/receivedDerivation.ts is the slot).
//
// THE RULE: reproduce what the node that wrote derived, with the SAME functions its write path uses, and nothing it replicated. What the writer's node wrote as a
// unit (anchors, paragraph rows and their tags, a line's task, review marks, tags a block save made or dropped, the attributes its text gives: migration 223) came
// in the bundle and is never written again here — a second task for one `- [ ] milk {task}` line, a second anchor, stamps of this node on the writer's write.
// What is derived (no stamp watches it) is worked out again from the merged state:
//   a note's body, anchors or paragraph rows changed, it was made, or it came back from the trash
//                         → bodyDerivation.ts deriveFromBody: its `[[links]]` out and link index, its paragraph rows' display, its anchor id index;
//   its space changed (written, or following its tree)
//                         → spaces.ts relinkAfterMove: edges that now cross spaces go, its links out and in are resolved in its new space;
//   it was made, came back, or its title or slug changed (and an `aliases` value changed: nodeCommits.ts)
//                         → wikilinkEdges.ts relinkTarget: the links INTO it;
//   a tag a block save made → blockNodes.ts markReceivedAutoTags (`_block_autotag`, derived: both nodes then drop the same stray tags);
//   a tag applied or removed, a tag's schema, parent or trash changed
//                         → attributeChange.ts retypeGoverned, the rows whose type is no unit only;
//   it was deleted for good (a `*` tombstone took the row)
//                         → nodeTrash.ts forgetPurgedNotes: its events, queued work, blobs, uploads and stored snapshot copy, read before the row went;
//   the modules' hooks    → spine/nodeHooks.ts with `received`: only modules that declare nodeHooksOnReceive (the website requests a rebuild when a note is
//                           unpublished, hidden, trashed, deleted or changes space — a leak if missed; the semantic index embeds a body);
//   a space, its switches or members changed, a note's space changed or a note was deleted for good
//                         → the membership epoch (db.ts bumpMembershipEpoch), so mirror clients reconcile.
// This node's own: the backup intent and the content hooks of a changed body (outbox rows, node-local). Domain events of a received change are batch 4b.
// The derivation writes no unit: test/receivedDerivation.integration.test.ts compares every unit and stamp of the workspace before and after it.
import type { BundleItem } from "../spine/snapshotSql.js";
import { deriving as step, setReceivedDerivation, tagsMadeWithTheirMark, type ReceivedBundle } from "../spine/receivedDerivation.js";
import { nodeLifecycleCommitted, nodeVisibilityCommitted, spaceAudienceCommitted } from "../spine/nodeHooks.js";
import { bumpMembershipEpoch } from "../db.js";
import { db } from "../dbKysely.js";
import { isUuid } from "@onden/markdown";
import { isTag } from "@onden/markdown/contract";
import type { ActorCtx, ActorType } from "../types.js";
import { deriveFromBody } from "./bodyDerivation.js";
import { relinkTarget } from "./wikilinkEdges.js";
import { relinkAfterMove } from "./spaces.js";
import { markReceivedAutoTags, notesOfBlockRows } from "./blockNodes.js";
import { retypeGoverned } from "./attributeChange.js";
import { contentOfNotesToPurge, forgetPurgedNotes, type PurgedContent } from "./nodeTrash.js";
import { enqueueBackup } from "./outbox.js";
import { nodeAttributeCommitted, nodeContentCommitted } from "./nodeCommits.js";

/** What the derivation reads of a note, before the merge and after it. */
type NoteState = { live: boolean; space: string | null; hidden: boolean; title: string; slug: string; tag: boolean; markdown: string };
/** `keys`: every note the bundle carries (held here or not); `notes`: those held here, as they were. */
type Prepared = { workspaceId: string; keys: string[]; notes: Map<string, NoteState>; purging: { ids: string[]; content: PurgedContent } | null };

const NOTES = "content_nodes";
const RECEIVED = { received: true } as const;

/** The row key an item of the bundle names (the row's own label's stamp, or the tombstone's). */
const rowKeyOf = (item: BundleItem): string | undefined =>
  item.kind === "row" ? item.stamps.find((s) => s.label === item.table)?.rowKey : item.stamp.rowKey;

async function notesAsTheyAre(workspaceId: string, ids: readonly string[]): Promise<Map<string, NoteState>> {
  if (ids.length === 0) return new Map();
  const rows = await db.selectFrom("content_nodes").select(["id", "deleted_at", "space_id", "hidden", "title", "slug", "node_type", "markdown"])
    .where("workspace_id", "=", workspaceId).where("id", "in", [...ids]).execute();
  return new Map(rows.map((r) => [r.id, { live: r.deleted_at === null, space: r.space_id, hidden: r.hidden, title: r.title, slug: r.slug, tag: isTag(r), markdown: r.markdown ?? "" }] as const));
}

async function before(workspaceId: string, items: readonly BundleItem[]): Promise<Prepared> {
  const keys = [...new Set(items.filter((i) => i.table === NOTES).map(rowKeyOf).filter((k): k is string => !!k && isUuid(k)))];
  const notes = await notesAsTheyAre(workspaceId, keys);
  // a note held here whose row a tombstone may take: what a permanent delete erases besides the row, read while the row is still here
  const going = items.filter((i) => i.kind === "tombstone" && i.table === NOTES && i.stamp.field === "*" && i.stamp.deleted).map(rowKeyOf).filter((k): k is string => !!k && notes.has(k));
  const purging = going.length ? { ids: going, content: await contentOfNotesToPurge(workspaceId, going) } : null;
  return { workspaceId, keys, notes, purging };
}

/** The workspace owner, as the hooks' actor: the one person a whole-workspace bundle is exchanged for (services/stampedBundle.ts). */
async function ownerOf(workspaceId: string): Promise<ActorCtx> {
  const row = await db.selectFrom("workspaces as w").innerJoin("actors as a", "a.id", "w.owner_actor_id")
    .select(["a.id", "a.name", "a.type"]).where("w.id", "=", workspaceId).executeTakeFirst();
  // never taken without its hooks: a takedown the website did not hear of is a leak
  if (!row) throw new Error(`workspace ${workspaceId} has no owner: a received change cannot reach its hooks`);
  return { id: row.id, name: row.name, type: row.type as ActorType };
}

const idsOf = (rows: Iterable<string>): string[] => [...new Set(rows)].filter(isUuid).sort();


async function after(prepared: Prepared, bundle: ReceivedBundle): Promise<void> {
  const { workspaceId, notes: was } = prepared;
  const units = bundle.units.map((e) => e.address);
  const of = (table: string, field?: string) => units.filter((u) => u.table === table && (field === undefined || u.field === field)).map((u) => u.row);
  const followed = new Map(bundle.followedSpaces.map((f) => [f.note, f] as const));
  const now = await notesAsTheyAre(workspaceId, idsOf([...prepared.keys, ...followed.keys()]));

  const made = [...now.keys()].filter((id) => !was.has(id));
  const gone = [...was.keys()].filter((id) => !now.has(id));
  const trashed = [...now].filter(([id, n]) => was.has(id) && was.get(id)!.live && !n.live).map(([id]) => id);
  const restored = [...now].filter(([id, n]) => was.has(id) && !was.get(id)!.live && n.live).map(([id]) => id);
  const named = [...now].filter(([id, n]) => was.has(id) && (was.get(id)!.title !== n.title || was.get(id)!.slug !== n.slug)).map(([id]) => id);
  const hiddenChanged = [...now].filter(([id, n]) => was.has(id) && was.get(id)!.hidden !== n.hidden).map(([id]) => id);
  const moved = idsOf([...[...now].filter(([id, n]) => was.has(id) && was.get(id)!.space !== n.space).map(([id]) => id),
    ...[...followed.values()].filter((f) => f.from !== f.to && now.has(f.note)).map((f) => f.note)]);

  // 1. a permanent delete: what it erases beyond the rows (the rows and what cascades from them went with the merge)
  if (prepared.purging && gone.length) await step("the erasing of a permanent delete", gone, () => forgetPurgedNotes(workspaceId, gone, prepared.purging!.content));

  // 2. the notes whose text, anchors or paragraph rows changed, that were made, or that came back: their own derived rows
  const bodyChanged = new Set([...of(NOTES, "body"), ...of(NOTES, "*")]);
  // an anchor row is the expansion of its note's anchors unit (spine/stampedMerge/dbUnits.ts expandAnchorUnits): an anchor that changed changed that unit, so the
  // note is among note_anchor_places' rows; a paragraph row names its note
  const otherNotes = [...of("note_anchor_places"), ...await notesOfBlockRows(workspaceId, of("block_nodes").filter(isUuid))];
  const derive = idsOf([...bodyChanged, ...otherNotes, ...made, ...restored]);
  const bodies = await notesAsTheyAre(workspaceId, derive);
  for (const id of derive) {
    const n = bodies.get(id);
    // a note in the trash whose text did not change keeps the links it had (a trashed source gains none: wikilinkEdges.ts relinkTarget)
    if (!n || (!n.live && !bodyChanged.has(id))) continue;
    await step("the links and paragraph rows of the text", [id], () => deriveFromBody(workspaceId, id, n.markdown));
  }

  // 3. what names a note, or where it is, changed: the links that cross spaces, and the links into it
  if (moved.length) await step("the links of notes that changed space", moved, () => relinkAfterMove(workspaceId, moved));
  const linkedTo = idsOf([...made, ...restored, ...named]);
  await step("the links into notes made, restored or renamed", linkedTo, () => relinkTarget(workspaceId, linkedTo));

  // 4. tags a block save made, and the value types that follow a tag's fields (only rows whose type is no unit)
  const madeTags = made.filter((id) => now.get(id)!.tag);
  await step("the marks of tags a block save made", madeTags, async () => markReceivedAutoTags(workspaceId, await tagsMadeWithTheirMark(workspaceId, madeTags)));
  const tagRows = of("node_tags").map((r) => r.split("/"));
  const tagsChanged = idsOf([...of("content_nodes.tag_schema"), ...[...of(NOTES, "parent"), ...trashed, ...restored].filter((id) => now.get(id)?.tag)]);
  const tagged = idsOf(tagRows.map(([n]) => n!));
  await step("the value types that follow tags", [...tagged, ...tagsChanged], () => retypeGoverned(workspaceId, { nodeIds: tagged, tagIds: tagsChanged }, { unstamped: true }));

  // 5. this node's own: the backup intent and the content hooks of each changed text; then the modules that hear received changes
  const actor = await step("the workspace's owner, the hooks' actor", [], () => ownerOf(workspaceId));
  for (const id of idsOf(bodyChanged)) {
    const n = bodies.get(id);
    if (!n) continue;
    await step("the backup and content hooks of the text", [id], async () => {
      await enqueueBackup({ workspaceId, nodeId: id, markdown: n.markdown, message: `RECEIVED: ${n.title}` });
      await nodeContentCommitted({ workspaceId, nodeId: id, text: `${n.title}\n\n${n.markdown}` }, RECEIVED);
    });
  }
  // an attribute value set or removed: what a local write of it runs after commit (nodeCommits.ts: the uploads it names, `aliases` re-links, and the modules that
  // hear received changes: the website on `_published`)
  const attributeKeys = [...new Set(of("node_attributes"))].map((row) => ({ nodeId: row.slice(0, row.indexOf("/")), key: row.slice(row.indexOf("/") + 1) })).filter((a) => isUuid(a.nodeId));
  if (attributeKeys.length) {
    // of a note this node holds (an attribute of a note deleted for good went with it); the value as it stands now (null: removed)
    const held = await notesAsTheyAre(workspaceId, attributeKeys.map((a) => a.nodeId));
    const stored = new Map((await db.selectFrom("node_attributes").select(["node_id", "key", "value"]).where("workspace_id", "=", workspaceId)
      .where("node_id", "in", attributeKeys.map((a) => a.nodeId)).execute()).map((r) => [`${r.node_id}/${r.key}`, r.value] as const));
    for (const { nodeId, key } of attributeKeys.sort((x, y) => (x.nodeId + x.key < y.nodeId + y.key ? -1 : 1))) {
      if (!held.has(nodeId)) continue;
      await step(`what follows from the value ${key}`, [nodeId], () => nodeAttributeCommitted({ workspaceId, nodeId, key, value: stored.get(`${nodeId}/${key}`) ?? null, actor }, RECEIVED));
    }
  }
  if (trashed.length) await step("the hooks of notes trashed", trashed, () => nodeLifecycleCommitted({ workspaceId, actor, nodeIds: trashed, change: "trashed" }, RECEIVED));
  if (restored.length) await step("the hooks of notes restored", restored, () => nodeLifecycleCommitted({ workspaceId, actor, nodeIds: restored, change: "restored" }, RECEIVED));
  const seen = idsOf([...hiddenChanged, ...tagRows.map(([n]) => n!)]);
  if (seen.length) await step("the hooks of notes whose visibility changed", seen, () => nodeVisibilityCommitted({ workspaceId, actor, nodeIds: seen }, RECEIVED));
  // a note deleted for good here with no trash first on this node (both came in one bundle): its row is gone, so no hook can ask whether the site showed it; the
  // site's rebuild drops whatever it no longer finds (a request too many costs one push, a missed takedown a leak)
  const audience = moved.length > 0 || gone.length > 0 || of("spaces.capabilities").length > 0;
  if (audience) await step("the hooks of a space's audience", [], () => spaceAudienceCommitted({ workspaceId, actor }, RECEIVED));

  // 6. who may read what changed: the epoch, once (the merge moves it too where a note's space followed its tree or a space's shown deletion changed)
  if (audience || of("spaces").length || of("space_members").length) await bumpMembershipEpoch(workspaceId);
}

setReceivedDerivation({ before, after: (prepared, bundle) => after(prepared as Prepared, bundle) });
