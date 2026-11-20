import { viewRecordsOf, withViews } from "./functionRefs.js";
import { appendOrderKey } from "./orderKeys.js";
import { addNoteLayoutTab } from "./boardStore.js";
import { randomUUID } from "node:crypto";
import { assertParentKind } from "./parentKind.js";
import { q } from "../db.js";
import { mutate } from "../spine/mutate.js";
import { assertAuthority } from "../spine/authority.js";
import { newNoteSpace } from "./spaces.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { withIdempotencyClaim } from "../spine/idempotency.js";
import type { ActorCtx } from "../types.js";
import { clampNoteTitle, HANDWRITING_LAYOUT, NODE_TITLE_MAX, slugify } from "@onden/markdown";
import { CONTENT_LAYOUT } from "@onden/markdown/contract";
import { putBlob } from "./blobs.js";
import type { AttributeState } from "./eventLog/index.js";
import { recordedTagMembership } from "./tagMembership.js";
import { uniqueSlug } from "./nodes.js";
import { finishNewNote } from "./newNoteDerived.js";
import { recordAttributeChange } from "./attributeChange.js";
import { isPersonAuthored, writableSource } from "../spine/attributeSource.js";
import { applyParentSiteDefault } from "./siteDefault.js";
import { isKeptOffSite, keptOffFromSource, PUBLISHED_KEY } from "./systemAttributes.js";
import { newNoteProof, type NewNoteProof } from "./newNoteProof.js";
import { isTaskSql } from "../spine/taskIdentity.js";
import { liveNodeSql } from "../spine/nodeSql.js";
import { isTag, isNote } from "@onden/markdown/contract";

type Source = {
  id: string;
  title: string;
  markdown: string;
  parent_id: string | null;
  space_id: string | null;
  deleted_at: string | null;
  node_type: string;
  is_task: boolean;
};
type CopyAttribute = AttributeState & { key: string };
const COPY_SUFFIX = " (Copy)";
type CopyTag = { id: string; title: string; node_type: string; deleted_at: string | null };

export class NoteDuplicateError extends Error {
  constructor(readonly status: 404 | 409 | 422, message: string) {
    super(message);
  }
}

export type DuplicateNoteOptions = {
  workspaceId: string;
  actor: ActorCtx;
  sourceId: string;
  /** Stable client UUID for ordinary copies; historical restore may omit it. */
  newNodeId?: string;
  /** Historical body/title replace only these fields, never the current parent/tags. */
  historical?: { title: string; markdown: string; eventId: string };
};

/** Atomically make a content-note copy. The source read, create role, current
 * parent and each direct tag are checked under the event lock. Attributes are
 * explicit user state; derived/internal fields, versions, tasks and source
 * edges are not copied. Tag relations get history without templates or defaults. */
export async function duplicateNote(options: DuplicateNoteOptions) {
  const { workspaceId, actor: authenticated, sourceId, historical } = options;
  const newNodeId = options.newNodeId ?? randomUUID();
  return withIdempotencyClaim(workspaceId, claim => withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    await claim();
    if (newNodeId === sourceId || (await q("SELECT 1 FROM content_nodes WHERE id=$1", [newNodeId])).rowCount) {
      throw new NoteDuplicateError(409, "new note id is already in use");
    }
    const source = (await q<Source>(
      `SELECT n.id,n.title,n.markdown,n.parent_id,n.space_id::text AS space_id,n.deleted_at,n.node_type,
         ${isTaskSql("n")} AS is_task FROM content_nodes n
       WHERE n.workspace_id=$1 AND n.id=$2 FOR UPDATE`,
      [workspaceId, sourceId],
    )).rows[0];
    if (!source || (!historical && source.deleted_at)) {
      throw new NoteDuplicateError(404, "source note not found");
    }
    if (!isNote(source) || source.is_task) {
      throw new NoteDuplicateError(422, "only content notes can be duplicated");
    }
    await assertAuthority(actor, { kind: historical ? "retained_node" : "node", nodeId: sourceId, op: "read" });
    await assertAuthority(actor, { kind: "any_space_write" });
    if (source.parent_id) {
      const parent = (await q<{ id: string }>(
        `SELECT id FROM content_nodes WHERE workspace_id=$1 AND id=$2 AND ${liveNodeSql()} FOR UPDATE`,
        [workspaceId, source.parent_id],
      )).rows[0];
      if (!parent) throw new NoteDuplicateError(409, "current parent is unavailable");
      await assertAuthority(actor, { kind: "node", nodeId: parent.id, op: "read" });
      await assertAuthority(actor, { kind: "node", nodeId: parent.id, op: "write_node" });
    }
    // A copy is a new note: it is not placed under a tag, even when its source
    // sits under one from before the trees were separated (services/parentKind.ts).
    await assertParentKind(workspaceId, "content", source.parent_id);
    // The copy sits next to its source: under the same parent note, or in the
    // source's space (services/spaces.ts newNoteSpace checks write there).
    const copySpace = await newNoteSpace(actor, workspaceId, { parentId: source.parent_id, spaceId: source.space_id });
    const tags = (await q<CopyTag>(
      `SELECT t.id,t.title,t.node_type,t.deleted_at FROM node_tags nt JOIN content_nodes t ON t.id=nt.tag_id
       WHERE nt.node_id=$1 AND t.workspace_id=$2 ORDER BY t.id`, [sourceId, workspaceId],
    )).rows;
    // A tag trashed (e.g. merged away) is not carried to the copy; the rest are.
    const liveTags = tags.filter((tag) => !tag.deleted_at);
    for (const tag of liveTags) {
      if (!isTag(tag)) throw new NoteDuplicateError(409, "direct tag is unavailable");
      await assertAuthority(actor, { kind: "tag", tagId: tag.id, op: "apply" });
    }

    // A copy keeps the values a person authored (isPersonAuthored: the same
    // rule as the zip export), except frontmatter ones: those come back from
    // the copied body (finishNewNote), and a restore-as-new body may no
    // longer have a key the current row holds.
    // A copy's place on the site is its space's, like any note's: a 「發布」
    // given to the source is not carried over, a 「不發布」 is (a note kept
    // off the site stays off when copied) whoever wrote it, an agent included.
    const ownRows = (await q<CopyAttribute>(
      `SELECT key,value,value_type,is_inheritable,source FROM node_attributes
       WHERE workspace_id=$1 AND node_id=$2
         AND left(key,8) <> '_import_'
       ORDER BY key`, [workspaceId, sourceId],
    )).rows;
    const keptOff = keptOffFromSource(ownRows);
    const attrs = ownRows.filter((a) => a.key !== PUBLISHED_KEY && isPersonAuthored(a.source) && a.source !== "frontmatter");
    if (keptOff) attrs.push({ ...keptOff, source: ownRows.find(isKeptOffSite)!.source });
    // A copy of a title at the cap still fits it (services/noteSize.ts).
    const title = historical?.title ?? `${clampNoteTitle(source.title, NODE_TITLE_MAX - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
    const markdown = historical?.markdown ?? source.markdown;
    const slug = await uniqueSlug(workspaceId, slugify(title), copySpace ? { spaceId: copySpace } : { parentId: source.parent_id });
    const bodyHash = await putBlob(markdown);
    return mutate({
      actor, workspaceId,
      authority: { kind: "any_space_write" },
      event: {
        type: "NODE_CREATED", targetType: "node", targetId: newNodeId,
        payload: { title, body_hash: bodyHash, copied_from_node: sourceId,
          ...(historical ? { restored_from_event: historical.eventId } : {}) },
        txMeta: { inverse_op: "node.deleted", ui_context: historical ? "event.restore.as_new" : "node.duplicate",
          ...(historical ? { restored_from: historical.eventId, restored_as_new_from_node: sourceId } : {}) },
        ...(historical ? { triggeredBy: historical.eventId } : {}),
      },
      apply: async ({ eventId }) => {
        const node = (await q<Record<string, unknown>>(
          `INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown,parent_id,space_id,order_key)
           VALUES($1,$2,'manual','content',$3,$4,$5,$6,$7,$8) RETURNING *`,
          [newNodeId, workspaceId, title, slug, markdown, source.parent_id, copySpace, await appendOrderKey("content_nodes", workspaceId, source.parent_id)],
        )).rows[0]!;
        const newNote = newNoteProof(newNodeId); // inserted just above (services/newNoteProof.ts)
        // Made under the same note as its source: that note's site default applies (siteDefault.ts).
        if (source.parent_id) await applyParentSiteDefault(workspaceId, source.parent_id, newNodeId, actor, undefined, newNote);
        for (const tag of liveTags) await recordCopiedTag(workspaceId, actor, newNodeId, tag);
        // A scoped actor must not create an invisible copy with no allowed tag.
        await assertAuthority(actor, { kind: "node", nodeId: newNodeId, op: "read" });
        for (const attr of attrs) await recordCopiedAttribute(workspaceId, actor, newNodeId, attr, newNote);
        // The 「手寫」 tab goes with its strokes (the attribute `note_ink` copied above), and the 「內容」 tab's record goes with the
        // text (a hidden 「內容」 stays hidden in the copy; none means the built-in tab, which needs no record). Each keeps its
        // place among the tabs; other views are the source's own.
        const sourceViews = await viewRecordsOf("note", workspaceId, sourceId);
        for (const layout of [HANDWRITING_LAYOUT, CONTENT_LAYOUT]) {
          const tab = sourceViews.find((v) => v.layout === layout);
          if (tab) await addNoteLayoutTab(newNodeId, layout, { name: String(tab.name), layoutConfig: tab.layout_config && typeof tab.layout_config === "object" ? tab.layout_config as Record<string, unknown> : {}, pinOrder: Number(tab.pin_order) || 0 });
        }
        // Rebuild only state derived from the copied body (createNote's own
        // step); never carry the source's explicit graph edges, versions or
        // task children across.
        await finishNewNote({ workspaceId, nodeId: newNodeId, title, slug, markdown }, { eventId, actor });
        return { node: await withViews(workspaceId, node as Record<string, unknown> & { id: string; node_type: string }), eventId };
      },
    });
  }));
}

/** Record an already-authorized copied relation and its TAG_APPLIED lineage.
 * Deliberately omits dispatcher, defaults and template expansion. */
async function recordCopiedTag(workspaceId: string, actor: ActorCtx, nodeId: string, tag: CopyTag) {
  await q(`INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)`, [nodeId, tag.id]);
  const change = await recordedTagMembership(nodeId, tag.id, true);
  await mutate({ actor, workspaceId,
    authority: { kind: "tag", tagId: tag.id, op: "apply" },
    // A tag on a published note shows as its chip and tag page.
    visibilityChanged: [nodeId],
    event: { type: "TAG_APPLIED", targetType: "node", targetId: nodeId,
      payload: { tag_id: tag.id, tag_name: tag.title, ...change },
      txMeta: { inverse_op: "tag.removed", tag_id: tag.id, ui_context: "node.duplicate" } },
    apply: async () => {},
  });
}

async function recordCopiedAttribute(workspaceId: string, actor: ActorCtx, nodeId: string, attr: CopyAttribute, newNote: NewNoteProof) {
  await recordAttributeChange({
    workspaceId, nodeId, key: attr.key, actor,
    next: { value: attr.value, value_type: attr.value_type, is_inheritable: attr.is_inheritable, source: writableSource(attr.source) },
    rule: "absent",
    // A copy of a note kept off the site takes 「不發布」 with it: the copy's own value from its source, not a choice of the mark, so an AI or a
    // temporary session copying it writes it too (attributeChange.ts assertActorMayWriteAttributeKey; the proof is for this copy).
    ...(isKeptOffSite(attr) ? { newNote } : {}),
    authority: { kind: "node", nodeId, op: "set_attribute" },
    uiContext: "node.duplicate",
  });
}
