// Edits to a tag's identity — its name (and the slug that follows it) and its
// color — moved from routes/tags.ts PATCH /api/tags/:id (depth audit D2). A
// title edit of the tag's node (PATCH /api/nodes/:id) writes here too (T11).

import { withEventTransaction } from "../spine/eventTransaction.js";
import { mutate, requireActor } from "../spine/mutate.js";
import { assertAuthority, type Authority } from "../spine/authority.js";
import { normalizeText } from "@onden/markdown";
import { q } from "../db.js";
import { sqlInt } from "../sqlText.js";
import { relinkTarget, slugForTitle } from "./nodes.js";
import { nodeContentCommitted } from "./nodeCommits.js";
import { assertTagNameAvailable, assertTagNameShape } from "./tagHierarchy.js";
import type { ActorCtx } from "../types.js";
import { liveTagNodeSql } from "../spine/nodeSql.js";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

export type TagIdentity = { id: string; name: string; color: string | null; schema_id: string | null };

/** Rename and/or recolor tag `id`. Owner only (principal_admin), checked
 *  before the body is read or the tag looked up; `readBody` parses the
 *  request. An unchanged request records nothing. Null when the tag is
 *  missing or deleted. Name/color affect every node carrying the tag, so the
 *  change is an attributed TAG_UPDATED with the previous values. */
export async function updateTagIdentity(
  authenticated: ActorCtx | null,
  ws: string,
  id: string,
  readBody: () => Promise<{ name?: string; color?: string | null }>,
): Promise<TagIdentity | null> {
  const actor = requireActor(authenticated);
  await assertAuthority(actor, { kind: "principal_admin" });
  const body = await readBody();
  return withEventTransaction(ws, async () =>
    (await writeTagIdentity(actor, ws, id, body, { authority: { kind: "principal_admin" }, uiContext: "tag.patch" }))?.tag ?? null);
}

/** The one write of a tag's name (and the `tag-` slug that follows it) and
 *  color, shared by PATCH /api/tags/:id and a title edit of the tag's node
 *  (services/nodeUpdate.ts), so a rename is always one TAG_UPDATED whose undo
 *  (eventRestore/tags.ts) puts the name and slug back together. The caller
 *  has asserted `authority` and holds the event lock; mutate re-checks it. A
 *  new name must have the tag-name shape and be free under the tag's parent
 *  (both in tagHierarchy.ts). Null when the tag is missing or deleted;
 *  eventId null when nothing changed (nothing recorded).
 *
 *  writeTagIdentity(actor, ws, id, { name: "reading" }, { authority, uiContext: "node.patch" }) */
export async function writeTagIdentity(
  actor: ActorCtx,
  ws: string,
  id: string,
  body: { name?: string; color?: string | null },
  { authority, uiContext }: { authority: Authority; uiContext: string },
): Promise<{ tag: TagIdentity; eventId: string | null } | null> {
  const prev = await q<{ name: string; color: string | null; slug: string; schema_id: string | null; parent_id: string | null; reserved_key: string | null }>(
    `SELECT title AS name, tag_color AS color, slug, parent_id, reserved_key, CASE WHEN tag_schema IS NOT NULL THEN id ELSE NULL END AS schema_id
       FROM content_nodes
      WHERE workspace_id = $1 AND id = $2 AND ${liveTagNodeSql()} FOR UPDATE`,
    [ws, id],
  );
  const before = prev.rows[0];
  if (!before) return null;
  // Tag names are stored in NFC (D58); the same name in either form is no
  // rename (a name stored decomposed before D58 stays as it is).
  if (body.name !== undefined) {
    const name = normalizeText(body.name);
    body = { ...body, name: name === normalizeText(before.name) ? before.name : name };
  }
  const renamed = body.name !== undefined && body.name !== before.name;
  if (renamed) {
    assertTagNameShape(body.name!);
    await assertTagNameAvailable(ws, id, { title: body.name!, parentId: before.parent_id });
  }
  const after = {
    name: body.name ?? before.name,
    slug: renamed ? await slugForTitle(ws, { id, node_type: TAG_NODE_TYPE, slug: before.slug, reserved_key: before.reserved_key }, body.name!) : before.slug,
    color: body.color === undefined ? before.color : body.color,
  };
  const changed = (["name", "slug", "color"] as const).filter((key) => before[key] !== after[key]);
  if (!changed.length) return { tag: { id, name: before.name, color: before.color, schema_id: before.schema_id }, eventId: null };
  return mutate({
    actor, workspaceId: ws, authority,
    event: {
      type: "TAG_UPDATED", targetType: "tag", targetId: id,
      payload: { changed, next_field_values: Object.fromEntries(changed.map((key) => [key, after[key]])) },
      txMeta: {
        inverse_op: "tag.updated",
        prev_field_values: Object.fromEntries(changed.map((key) => [key, before[key]])),
        ui_context: uiContext,
      },
    },
    apply: async ({ eventId }) => {
      const tag = await applyTagIdentity(ws, id, { ...(renamed ? { name: after.name, slug: after.slug } : {}), color: after.color }, { eventId });
      return { tag: tag!, eventId };
    },
  });
}

const IDENTITY_COLUMNS = { name: "title", slug: "slug", color: "tag_color" } as const;
export type TagIdentityColumns = { name?: string; slug?: string; color?: string | null };

/** The one UPDATE of a tag's name, slug and color, shared by writeTagIdentity
 *  and the undo of a TAG_UPDATED (eventRestore/tags.ts): only the supplied
 *  columns are written, and a supplied name also re-links `[[name]]` and
 *  refreshes the tag's searchable text (tagNameCommitted). In the caller's
 *  transaction; the caller records the event (`eventId` once it exists).
 *  Schema identity may intentionally differ (migration 074): a rename changes
 *  this node's identity and leaves the pack's alone. Null when the tag is
 *  missing or deleted.
 *
 *  applyTagIdentity(ws, id, { name: "reading", slug: "tag-reading" }, { eventId }) */
export async function applyTagIdentity(
  ws: string,
  id: string,
  columns: TagIdentityColumns,
  { eventId }: { eventId?: string } = {},
): Promise<TagIdentity | null> {
  const keys = (Object.keys(IDENTITY_COLUMNS) as Array<keyof typeof IDENTITY_COLUMNS>).filter((key) => key in columns);
  const assignments = keys.map((key, index) => `${IDENTITY_COLUMNS[key]} = $${sqlInt(index + 3)}`);
  const result = await q<TagIdentity>(
    `UPDATE content_nodes SET ${[...assignments, "updated_at = now()"].join(", ")}
      WHERE workspace_id = $1 AND id = $2 AND ${liveTagNodeSql()}
      RETURNING id, title AS name, tag_color AS color, CASE WHEN tag_schema IS NOT NULL THEN id ELSE NULL END AS schema_id`,
    [ws, id, ...keys.map((key) => columns[key])],
  );
  if ("name" in columns) await tagNameCommitted(ws, id, eventId);
  return result.rows[0] ?? null;
}

/** A tag's name is part of its node's searchable text: after a rename (or the
 *  undo of one) the module content hooks see the new title, so the search
 *  embedding follows it the way a title edit of any note does, and the notes
 *  that `[[name]]` the tag are re-linked. In the write transaction. */
async function tagNameCommitted(ws: string, id: string, eventId?: string): Promise<void> {
  await relinkTarget(ws, [id]);
  const row = (await q<{ title: string; markdown: string | null }>(
    `SELECT title, markdown FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [ws, id])).rows[0];
  if (row) await nodeContentCommitted({ workspaceId: ws, nodeId: id, text: `${row.title}\n\n${row.markdown ?? ""}`, triggeredByEventId: eventId });
}
