// Sub-tree template expander — fires when a class-tag is applied to a node.
//
// The expansion is the operational mirror of Tana's "Default Content" and
// Godot's "scene-as-prefab" pattern: a class_tag's schema can carry an
// ordered list of `template_children`, each one a slot describing a child
// node that should exist under the tagged node after the tag is applied.
//
// Properties we hold:
//
//   • Idempotent. Re-applying the same tag never duplicates a slot's child.
//     Each created child carries an `_tpl_origin` attribute of the form
//     "<parent_node_id>:<applied_tag_slug>:<slot_index>" — apply scans the
//     parent's direct children for matching markers and skips filled slots.
//     The child's title/markdown may have been edited; the marker is what
//     identifies "this slot has been filled".
//
//   • Bounded recursion. A slot may name `child_class_tag_slug`, which
//     applies that tag to the spawned child (and may itself trigger another
//     expansion). MAX_DEPTH = 3 caps the chain so a cyclic schema can't
//     spiral. The depth counter and a visited-tag set guard against this.
//
//   • Best-effort. Expansion failures don't roll back the tag apply itself
//     — the user successfully tagged the node, the dispatcher fired,
//     children are convenience. Per-slot errors are logged but swallowed.
//
//   • No write outside the spawned subtree. The expander never touches
//     pre-existing nodes or attributes — purely creates new ones with the
//     `_tpl_origin` reserved marker.

import { randomUUID } from "node:crypto";
import { q, withSavepoint } from "../db.js";
import { mutate, runCascade } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";
import { putBlob } from "./blobs.js";
import { uniqueSlug } from "./nodes.js";
import { applyChildPrefixAttributes } from "./childAttributes.js";
import { applyParentSiteDefault } from "./siteDefault.js";
import { finishNewNote } from "./newNoteDerived.js";
import { recordAttributeChange } from "./attributeChange.js";
import { attachTagInTx } from "./tagMembershipWrites.js";
import { appendOrderKey } from "./orderKeys.js";
import { newNoteProof } from "./newNoteProof.js";
import { applyTemplateVars, slugify } from "@onden/markdown";
import { localDateTimeId, localDayId } from "../localDay.js";
import { liveNodeSql, liveTagNodeSql } from "../spine/nodeSql.js";

const MAX_DEPTH = 3;

type TemplateChild = {
  title: string;
  body?: string;
  child_class_tag_slug?: string;
};


export async function expandTemplate(
  workspaceId: string,
  parentNodeId: string,
  tagId: string,
  actor: ActorCtx,
  // The event that caused this expansion (TAG_APPLIED at the top; the spawned
  // child's NODE_CREATED in recursion) — every emitted event points
  // triggered_by here, so inbox grouping + cascade reject/preview can see
  // template children. Before this, expansion DROPPED provenance entirely
  // (found by the cascade-preview endpoint's own integration test).
  causeEventId?: string,
  depth = 0,
  visitedTags: Set<string> = new Set(),
): Promise<void> {
  if (depth >= MAX_DEPTH) return;
  if (visitedTags.has(tagId)) return; // cycle guard

  // P4.1 (mig 073/074): schema slug + template_children off the tag node's
  // tag_schema shadow, no collection_schemas JOIN.
  const tagRow = await q<{ slug: string | null; template_children: unknown }>(
    `SELECT t.tag_schema->>'slug' AS slug,
            COALESCE(t.tag_schema->'template_children', '[]'::jsonb) AS template_children
     FROM content_nodes t
     WHERE t.id = $1 AND t.workspace_id = $2
       AND ${liveTagNodeSql("t")}`,
    [tagId, workspaceId],
  );
  const row = tagRow.rows[0];
  if (!row?.slug) return; // label tag or missing schema — nothing to expand

  const tagSlug = row.slug;
  const slots = (Array.isArray(row.template_children) ? row.template_children : []) as TemplateChild[];
  if (slots.length === 0) return;

  visitedTags.add(tagId);
  // `{date}` / `{datetime}` in a slot's title or body read as in the app's note
  // templates (@onden/markdown applyTemplateVars, D69); one moment for the
  // whole expansion, so sibling slots agree.
  const now = new Date();
  const vars = { date: localDayId(now), datetime: localDateTimeId(now) };

  // Pre-load existing slot markers so we make one query instead of one per
  // slot. Direct children only — a slot whose child was moved deeper isn't
  // considered filled.
  const filledRes = await q<{ value: string }>(
    `SELECT na.value
     FROM content_nodes cn
     JOIN node_attributes na ON na.node_id = cn.id
     WHERE cn.parent_id = $1 AND cn.workspace_id = $2 AND na.key = '_tpl_origin' AND ${liveNodeSql("cn")}`,
    [parentNodeId, workspaceId],
  );
  const filledMarkers = new Set(filledRes.rows.map((r) => r.value));

  // Expansion is a derived effect of the tag application the caller already
  // authorized; it only creates NEW subtree nodes (never touches pre-existing
  // ones), so it carried no node write-check historically — `open` records that
  // honestly rather than adding a gate that could mis-deny. runCascade opens the
  // store so every spawned NODE_CREATED rides the spine as a cascade child of
  // the TAG_APPLIED root (triggered_by = causeEventId).
  await runCascade(
    {
      actor,
      workspaceId,
      authority: { kind: "open", why: "template expansion rides the route-authorized tag apply; creates only new subtree nodes" },
      causeEventId,
    },
    async () => {
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (!slot || typeof slot.title !== "string" || slot.title.trim().length === 0) continue;
        const marker = `${parentNodeId}:${tagSlug}:${i}`;
        if (filledMarkers.has(marker)) continue;

        try {
          // events->hash->blobs: content-address the spawned child's body so its
          // NODE_CREATED carries body_hash like every other create path. Idempotent
          // (content-addressed), so it's safe to do before the tx.
          const slotTitle = applyTemplateVars(slot.title, vars).trim();
          const slotBody = applyTemplateVars(slot.body ?? "", vars);
          const childBodyHash = await putBlob(slotBody);
          // ONE savepoint per slot: child node + marker + child-prefix attrs and,
          // if the slot names a child class-tag, that tag's full application and
          // the recursive expansion. A failed slot rolls back on its own and the
          // others continue (SLOT_FAILED is recorded below), whether the caller
          // already holds a transaction (every attachTagInTx path) or not.
          const childId = randomUUID();
          await withSavepoint(async () => {
            const childEventId = await mutate<string>({
              actor, workspaceId, authority: { kind: "cascade" },
              event: {
                type: "NODE_CREATED", targetType: "node", targetId: childId,
                payload: {
                  title: slotTitle,
                  body_hash: childBodyHash,
                  spawned_by: { tag_id: tagId, parent_id: parentNodeId, slot_index: i },
                },
              },
              timing: "before",
              apply: async ({ eventId }) => {
                // Under the event lock: a concurrent create of the same title has
                // committed or waits, so the slug cannot collide.
                const slug = await uniqueSlug(workspaceId, slugify(slotTitle));
                const title = slotTitle;
                const markdown = slotBody;
                await q(
                  `INSERT INTO content_nodes
                     (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id, hidden, order_key)
                   VALUES ($1, $2, 'manual', 'content', $3, $4, $5, $6, false, $7)`,
                  [childId, workspaceId, title, slug, markdown, parentNodeId, await appendOrderKey("content_nodes", workspaceId, parentNodeId)],
                );
                // Reserved key — the attribute panel hides `_`-prefixed entries.
                // source='derived' because the value is computed from the tag/slot
                // pair rather than typed by a user.
                await recordAttributeChange({
                  workspaceId, nodeId: childId, key: "_tpl_origin", actor,
                  next: { value: marker, source: "derived" }, rule: "always",
                  authority: { kind: "cascade" }, uiContext: "tag.template.slot",
                });
                // `child:` prefix attributes from the parent flow into spawned
                // children the same way they do for manual node creation.
                await applyChildPrefixAttributes(workspaceId, parentNodeId, childId, actor);
                await applyParentSiteDefault(workspaceId, parentNodeId, childId, actor, undefined, newNoteProof(childId)); // the slot inserted above
                // What createNote gives a new note's text (backup, links, block
                // ids, embedding); the slot's body is the child's text.
                await finishNewNote({ workspaceId, nodeId: childId, title, slug, markdown }, { eventId, actor });
                return eventId;
              },
            });

            // Apply the child class_tag if requested, and recurse to handle its
            // own template_children. visitedTags keeps a tag from re-entering
            // itself further down the chain. All in this same tx as the child.
            if (slot.child_class_tag_slug) {
              // A1.6: lookup child tag from content_nodes shadow. q() (NOT
              // pool.query) reads THIS tx — the just-created child is uncommitted,
              // and the node_tags FK on node_id means a separate pooled connection
              // would block on that uncommitted row while this async context awaits
              // it → an undetectable self-deadlock/hang.
              const childTag = await q<{ id: string }>(
                // P4.1 (mig 074): match the child class-tag by title OR its schema
                // slug, read off the node's tag_schema shadow — no JOIN.
                `SELECT t.id FROM content_nodes t
                 WHERE t.workspace_id = $1 AND (t.title = $2 OR t.tag_schema->>'slug' = $2)
                   AND ${liveTagNodeSql("t")}
                 LIMIT 1`,
                [workspaceId, slot.child_class_tag_slug],
              );
              const childTagId = childTag.rows[0]?.id;
              if (childTagId) {
                // The full apply contract (attachTagInTx), atomic with the child;
                // an idempotent re-expansion finds the link and re-fires nothing.
                await attachTagInTx({
                  workspaceId, nodeId: childId, tagId: childTagId, actor,
                  // A copy per branch: visitedTags is the ancestor path (cycle
                  // guard), not "seen anywhere" — a sibling slot naming the same
                  // child tag must still expand that child's own template.
                  causeEventId: childEventId, content: { depth: depth + 1, visitedTags: new Set(visitedTags) },
                });
              }
            }
          });
        } catch (err) {
          // Per-slot best-effort. We've already let the tag apply succeed; a
          // failed slot just means the user doesn't get that child node and
          // can create it manually.
          await mutate({
            actor, workspaceId, authority: { kind: "cascade" },
            event: {
              type: "TAG_TEMPLATE_SLOT_FAILED", targetType: "node", targetId: parentNodeId,
              payload: {
                tag_id: tagId, slot_index: i, slot_title: slot.title,
                error: (err as Error).message,
              },
            },
            apply: async () => {},
          });
        }
      }
    },
  );
}
