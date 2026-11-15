// Recording one attribute change — the one place that writes a node_attributes
// row and its ATTRIBUTE_SET / ATTRIBUTE_DELETED event together.
//
// Every writer goes through recordAttributeChange: the attribute route, text
// derivation (inline `key:: value` and frontmatter), child:* copy-down, field
// defaults, task fields, copies. So every change
//   * reaches other devices (the sync delta reads ATTRIBUTE_* events);
//   * can be undone (the event carries the before and after snapshots: the
//     locked row it replaces and exactly the row it stores);
//   * follows one precedence rule (sync-protocol §5: ui > frontmatter >
//     markdown > dispatcher), for deletes as well as writes.
// Before this module text-derived values, child:* copies and field defaults
// were raw INSERTs without events: invisible to sync and impossible to undo.
//
// The one write without an event is retypeGoverned (below): value_type is
// derived from the schema, and when a tag or schema write changes which field
// governs a key it brings the stored type back to the rule, value untouched.

import { sql } from "kysely";
import { q } from "../db.js";
import { db } from "../dbKysely.js";
import type { ActorCtx } from "../types.js";
import { mutate } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { assertAuthority, type Authority } from "../spine/authority.js";
import { incomingWins, PERSON_SOURCE, writableSource, type AttributeSource, type AttributeWriteSource } from "../spine/attributeSource.js";
import { encodeSnapshot, type AttributeState } from "./eventLog/index.js";
import { ATTRIBUTE_KEY_RULE, governingField, isSettableAttributeKey, normalize, normalizeText, type AttributeValueType } from "@onden/markdown";
import { fieldForKey } from "./schemaValidation.js";
import { effectiveTagFields, loadTagFieldRows } from "./tagFields.js";
import { extendsIdsOf } from "./tagExtendsList.js";
import { nodeAttributeCommitted } from "./nodeCommits.js";
import { liveTagNodeSql } from "../spine/nodeSql.js";

/** A refused attribute value. Maps to `{ error: code, detail? }` with `status`
 *  at the HTTP boundary (400 reserved or invalid key, 422 invalid field value). */
export class AttributeWriteError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 422, readonly code: string, readonly detail?: string) {
    super(detail ?? code);
    this.name = "AttributeWriteError";
  }
}

/** The event type recording a change to `next` (null = removed). The restore
 *  path names its inverse events with this too. */
export function attributeEventType(next: unknown | null): "ATTRIBUTE_SET" | "ATTRIBUTE_DELETED" {
  return next === null ? "ATTRIBUTE_DELETED" : "ATTRIBUTE_SET";
}

export type AttributeChange = {
  workspaceId: string;
  nodeId: string;
  key: string;
  actor: ActorCtx;
  /** The value to hold, or null to remove the attribute. When the key is a
   *  schema field on one of the node's tags, the stored value_type is the
   *  field's (@onden/markdown attributeValue: a rating is a number, a date a
   *  date) whatever the writer passed, so typed sorts and filters see every
   *  writer's values alike; a value the field refuses (only reachable without
   *  `validate`) and an empty value are stored as text. For a free-form key
   *  value_type is a hint; without one the type is inferred from the value
   *  (attributeValue.freeFormType); the existing row's type is the hint
   *  when none is sent. is_inheritable and source
   *  default to the existing row's (else false, "ui": PERSON_SOURCE);
   *  "priority" needs an explicit source. Legacy `explicit` is never
   *  written (spine/attributeSource.ts). */
  next: { value: string; value_type?: string; is_inheritable?: boolean; source?: AttributeWriteSource } | null;
  /** When a write happens:
   *   "always"   — an explicit edit: last write wins, even an unchanged value
   *                is recorded;
   *   "priority" — derived input: only over a value of equal or lower
   *                precedence, and only when the value changes;
   *   "absent"   — only when the node has no such attribute (defaults,
   *                child:* copies). */
  rule: "always" | "priority" | "absent";
  /** Checked by the spine on the event; `{ kind: "cascade" }` inside a write
   *  that already holds it. */
  authority: Authority;
  uiContext: string;
  /** Refuse (422) a value the key's schema field does not accept, instead of
   *  storing it as text, and (400 invalid_key) a new free-form key outside
   *  the attribute key grammar. */
  validate?: boolean;
  /** With `validate`: the key exists already (restored from a backup), so a
   *  key outside the grammar is accepted; the value is still checked. */
  keepStoredKey?: boolean;
  /** A value the new note takes from where it is made (a parent's `child:` value, its site default, a tag's field default).
   *  It is written as source 'derived', which the stamp trigger leaves alone, but another node cannot work it out again
   *  (the parent or the schema may have changed), so it is stamped here; the source stays as it is. */
  inheritedAtCreation?: boolean;
  /** Extra payload fields (which tag default wrote it, …). */
  payload?: Record<string, unknown>;
  triggeredBy?: string;
  /** Writes that belong to this event (a conflict record). */
  within?: (ctx: {
    eventId: string; previous: AttributeState | null; previousUpdatedAt: string | null; row: AttributeState | null;
    /** The logical-clock reading (epoch ms) of the stamp the replaced value carries, read before this write replaced it;
     *  null when that row has no stamp (written before stamps, or a value the note's text produced). */
    previousStampWall: number | null;
  }) => Promise<void>;
};

/** The sources the stamp trigger stamps by itself (migration 194, sync_stamp_attribute_trigger). */
const STAMPED_SOURCES: readonly string[] = ["ui", "explicit", "dispatcher"];

const stampRowKey = (nodeId: string, key: string) => `${nodeId}/${key}`;

/** Put the open transaction's stamp on a row of `node_attributes` the trigger skips (same call the trigger makes). */
async function putAttributeStamp(workspaceId: string, nodeId: string, key: string, deleted: boolean): Promise<void> {
  await sql`SELECT sync_stamp_put(${workspaceId}::uuid, 'node_attributes', ${stampRowKey(nodeId, key)}, '*', ${deleted}, sync_stamp_current(${workspaceId}::uuid))`.execute(db);
}

async function tombstoneStampedAttribute(workspaceId: string, nodeId: string, key: string): Promise<void> {
  const live = await sql`SELECT 1 FROM sync_stamps WHERE workspace_id = ${workspaceId}::uuid AND table_name = 'node_attributes'
    AND row_key = ${stampRowKey(nodeId, key)} AND field = '*' AND NOT deleted`.execute(db);
  if (live.rows.length) await putAttributeStamp(workspaceId, nodeId, key, true);
}

export type AttributeChangeResult =
  | { written: false; current: AttributeState | null }
  | { written: true; previous: AttributeState | null; row: AttributeState | null; eventId: string };

/** Write one attribute change and its event in one transaction (joins the
 *  caller's). Returns written:false when the rule keeps the current value.
 *  Throws AttributeWriteError for a value its schema field refuses. */
export async function recordAttributeChange(change: AttributeChange): Promise<AttributeChangeResult> {
  const { workspaceId, nodeId, next } = change;
  return withEventTransaction(workspaceId, async () => {
    // Under the append lock with the row locked: the before-state is the one
    // this event replaces, and the after-state below is exactly what the
    // write stores, so both snapshots describe real rows.
    // stamp_wall: the value's own stamp ('value' field, else the whole row's), the clock every stamp is compared on.
    const lockRow = async (key: string) => (await q<AttributeState & { updated_at: string; stamp_wall: string | null }>(
      `SELECT a.value, a.value_type, a.is_inheritable, a.source, a.updated_at,
              (SELECT s.hlc_wall::text FROM sync_stamps s
                WHERE s.workspace_id = a.workspace_id AND s.table_name = 'node_attributes'
                  AND s.row_key = a.node_id::text || '/' || a.key AND s.field IN ('value', '*') AND NOT s.deleted
                ORDER BY (s.field = 'value') DESC LIMIT 1) AS stamp_wall
         FROM node_attributes a
        WHERE a.workspace_id = $1 AND a.node_id = $2 AND a.key = $3 FOR UPDATE OF a`,
      [workspaceId, nodeId, key],
    )).rows[0] ?? null;
    // Keys are stored in NFC (D58). A row stored under the key exactly as
    // given (one written decomposed before D58) is still that row, so it can
    // be edited and removed; otherwise the change is to the NFC key.
    let key = change.key;
    let locked = await lockRow(key);
    if (!locked && normalizeText(key) !== key) {
      key = normalizeText(key);
      locked = await lockRow(key);
    }
    const previous: AttributeState | null = locked && {
      value: locked.value, value_type: locked.value_type, is_inheritable: locked.is_inheritable, source: locked.source,
    };

    let row: AttributeState | null = null;
    if (next) {
      if (change.rule === "absent" && previous) return { written: false, current: previous };
      if (change.rule === "priority" && (previous?.value === next.value || !incomingWins(next.source ?? PERSON_SOURCE, previous?.source))) {
        return { written: false, current: previous };
      }
      // Only a value that will be written pays for the field lookup (a body
      // save re-derives every inline value, most unchanged). The governing
      // field decides the storage type; `q` joins the caller's transaction, so
      // tags applied earlier in it (a note created with its tags and values,
      // a tag's defaults) are seen.
      const field = await fieldForKey(workspaceId, nodeId, key);
      // D44: a key someone adds must be one every grammar reads back
      // (@onden/markdown attributeKey.ts), or it is lost on the export →
      // import round trip; `child:` + such a key is the copy-down form
      // (childAttributes.ts). A key the node already has, or a schema field
      // declares (a CSV column such as "Due Date"), stays editable: those were
      // made before the grammar, and no migration renames them.
      if (change.validate && !change.keepStoredKey && !previous && !field && !isSettableAttributeKey(key)) {
        throw new AttributeWriteError(400, "invalid_key", `attribute name ${JSON.stringify(key)} must be ${ATTRIBUTE_KEY_RULE}`);
      }
      const stored = normalize(field, next.value, (next.value_type ?? previous?.value_type) as AttributeValueType | undefined);
      if (!stored.ok && change.validate) throw new AttributeWriteError(422, "field_invalid", stored.reason);
      row = {
        value: next.value,
        value_type: stored.ok ? stored.value_type : "text",
        is_inheritable: next.is_inheritable ?? previous?.is_inheritable ?? false,
        source: next.source ?? (previous ? writableSource(previous.source) : PERSON_SOURCE),
      };
    } else {
      if (!previous) {
        // Nothing to remove, nothing written: but an explicit removal still answers only to someone who may remove,
        // so "not there" and "not yours" cannot be told apart by who is asking.
        if (change.rule === "always") await assertAuthority(change.actor, change.authority);
        return { written: false, current: null };
      }
    }

    // The spine checks authority before apply writes anything.
    const eventId = await mutate<string>({
      actor: change.actor,
      workspaceId,
      authority: change.authority,
      event: {
        type: attributeEventType(row),
        targetType: "node",
        targetId: nodeId,
        payload: { key, ...(row ? await encodeSnapshot(key, row) : {}), ...change.payload },
        ...(change.triggeredBy ? { triggeredBy: change.triggeredBy } : {}),
        txMeta: {
          inverse_op: previous ? "attribute.set" : "attribute.deleted",
          prev_field_values: await encodeSnapshot(key, previous),
          ui_context: change.uiContext,
        },
      },
      apply: async ({ eventId }) => {
        if (row) {
          await q(
            `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, now())
             ON CONFLICT (node_id, key) DO UPDATE
               SET value = EXCLUDED.value, value_type = EXCLUDED.value_type,
                   is_inheritable = EXCLUDED.is_inheritable, source = EXCLUDED.source, updated_at = now()`,
            [workspaceId, nodeId, key, row.value, row.value_type, row.is_inheritable, row.source],
          );
        } else {
          await q(`DELETE FROM node_attributes WHERE workspace_id = $1 AND node_id = $2 AND key = $3`, [workspaceId, nodeId, key]);
          // The trigger leaves a derived row's removal alone; if the row was stamped at creation, say it is gone.
          if (previous && !STAMPED_SOURCES.includes(previous.source ?? "")) await tombstoneStampedAttribute(workspaceId, nodeId, key);
        }
        if (row && change.inheritedAtCreation && !STAMPED_SOURCES.includes(row.source ?? "")) await putAttributeStamp(workspaceId, nodeId, key, false);
        await change.within?.({
          eventId, previous, previousUpdatedAt: locked?.updated_at ?? null, row,
          previousStampWall: locked?.stamp_wall == null ? null : Number(locked.stamp_wall),
        });
        return eventId;
      },
    });
    // Modules react once the root transaction commits (the website takes a
    // page off when `_published` goes): fired here, so no writer can forget.
    await nodeAttributeCommitted({ workspaceId, nodeId, key, value: row?.value ?? null, actor: change.actor });
    return { written: true, previous, row, eventId };
  });
}

/** D94: bring stored value_types back to the rule after a write that changed
 *  which field governs a key — not the value — so typed reads (a saved view's
 *  sort and range filters, rollups) agree with the app, which types values
 *  from the current schema. Each attribute row of the affected notes is run
 *  through normalize again under the fields that govern it NOW (fieldForKey's
 *  rule: the note's live tags in tag order, their effective fields): a
 *  governed value gets its field's storage type (text when the field refuses
 *  it, as recordAttributeChange stores it), a free-form one keeps its stored
 *  type as the writer's hint when the value fits it (a date that was a date
 *  field's stays a date after the tag goes), else freeFormType.
 *
 *  The affected notes: `nodeIds`, and the notes carrying any of `tagIds` or a
 *  live tag inheriting from one of them (child tags and tags that extend it,
 *  at any depth — whose effective fields follow theirs). A trashed tag still
 *  reaches its notes (node_tags rows survive the trash).
 *
 *  Like migration 105: only value_type changes — the value, source and
 *  updated_at stay, and no event is recorded, so a retype is no edit, raises
 *  no conflict and no sync noise (devices type values from the schema
 *  themselves; undo types both sides by the same rule). An imported note's
 *  retyped rows keep their type before in `_import_retyped` (first retype
 *  wins), so a pre-D21 import baseline still reproduces
 *  (modules/importers/shared/identity.ts). Call inside the changing write's transaction,
 *  after it (`q` sees it). Returns how many rows were retyped.
 *
 *  Every write that changes governance calls it: tag apply/remove and their
 *  undo, writeTagSchema, a tag's parent move (edit, undo, merge), a tag's
 *  trash and restore (test/retypeWriters.test.ts holds the list). */
export async function retypeGoverned(
  workspaceId: string, scope: { nodeIds?: readonly string[]; tagIds?: readonly string[] },
): Promise<number> {
  const tagRows = await loadTagFieldRows(workspaceId);
  const tagIds = new Set(scope.tagIds ?? []);
  if (tagIds.size) {
    // Who inherits from whom: a child names its parent, an extender the tags
    // it extends (tagFields.effectiveTagFields walks the same edges upwards).
    const heirs = new Map<string, string[]>();
    for (const row of tagRows) {
      for (const from of [...(row.parent_id ? [row.parent_id] : []), ...extendsIdsOf(row.extends)]) {
        heirs.set(from, [...heirs.get(from) ?? [], row.id]);
      }
    }
    for (const id of tagIds) for (const heir of heirs.get(id) ?? []) tagIds.add(heir);
  }
  const nodeIds = [...new Set(scope.nodeIds ?? [])];
  if (!nodeIds.length && !tagIds.size) return 0;

  const attrs = (await q<{ id: string; node_id: string; key: string; value: string; value_type: string }>(
    `SELECT id::text, node_id::text, key, value, value_type FROM node_attributes
      WHERE workspace_id = $1
        AND (node_id = ANY($2::uuid[]) OR node_id IN (SELECT node_id FROM node_tags WHERE tag_id = ANY($3::uuid[])))`,
    [workspaceId, nodeIds, [...tagIds]],
  )).rows;
  if (!attrs.length) return 0;
  const tagsOf = new Map<string, string[]>();
  for (const { node_id, tag_id } of (await q<{ node_id: string; tag_id: string }>(
    `SELECT nt.node_id::text, t.id::text AS tag_id
       FROM node_tags nt
       JOIN content_nodes t ON t.id = nt.tag_id
        AND ${liveTagNodeSql("t")} AND t.workspace_id = $1
      WHERE nt.node_id = ANY($2::uuid[])
      ORDER BY t.created_at, t.id`,
    [workspaceId, [...new Set(attrs.map((a) => a.node_id))]],
  )).rows) tagsOf.set(node_id, [...tagsOf.get(node_id) ?? [], tag_id]);

  const effective = effectiveTagFields(tagRows);
  const retyped = attrs.flatMap((row) => {
    const field = governingField((tagsOf.get(row.node_id) ?? []).flatMap((tag) => (effective.get(tag) ?? []).filter((f) => f.name === row.key)));
    const stored = normalize(field, row.value, row.value_type as AttributeValueType);
    const valueType = stored.ok ? stored.value_type : "text";
    return valueType === row.value_type ? [] : [{ ...row, new_type: valueType }];
  });
  if (!retyped.length) return 0;

  const ids = retyped.map((r) => r.id);
  // The imported notes' types before (see above), as migration 105 kept them.
  await q(
    `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
     SELECT $1, r.node_id, '_import_retyped', jsonb_object_agg(r.key, r.old_type)::text, 'text', false, 'derived'
       FROM unnest($2::uuid[], $3::text[], $4::text[]) AS r(node_id, key, old_type)
      WHERE EXISTS (SELECT 1 FROM node_attributes b WHERE b.node_id = r.node_id AND b.key = '_import_baseline')
      GROUP BY r.node_id
     ON CONFLICT (node_id, key) DO UPDATE
       SET value = ((EXCLUDED.value)::jsonb || (node_attributes.value)::jsonb)::text`,
    [workspaceId, retyped.map((r) => r.node_id), retyped.map((r) => r.key), retyped.map((r) => r.value_type)],
  );
  await q(
    `UPDATE node_attributes na SET value_type = r.new_type
       FROM unnest($1::uuid[], $2::text[]) AS r(id, new_type)
      WHERE na.id = r.id`,
    [ids, retyped.map((r) => r.new_type)],
  );
  return retyped.length;
}
