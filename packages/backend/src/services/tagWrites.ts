// Writing a tag row — the one place that knows its shape.
//
// A tag is a class_tag content_node. Its schema (fields, views, behaviour, …)
// lives on the node as tag_schema jsonb. Before this module eight services each
// wrote their own `INSERT … 'class_tag'` and six wrote tag_schema by hand, each
// choosing the slug, the default colour, the empty schema and the event shape
// for itself (depth audit 2026-10-15, D1). Now:
//
//   * insertTagRow     — the only class_tag INSERT (siteConfig's self-healing
//                        upsert excepted; see test/tagWrites.test.ts). It picks
//                        the tag slug and fills the columns. The caller still
//                        owns the event and authority, which differ legitimately
//                        (TAG_CREATED by any writer vs TAG_IMPORTED by the owner).
//                        A user creating a plain tag goes through
//                        tagHierarchy.createTag, not here directly.
//   * buildTagSchema   — the canonical tag_schema object.
//   * writeTagSchema   — the only UPDATE of tag_schema: replace, or merge keys.
//
// Both writers leave out the retired automation keys (withoutAutomation) and
// check the fields a write brings against the one field shape
// (services/fieldSchema.ts), throwing InvalidFieldError (400) before storing a
// field nothing reads right (D48).
// Every schema write — schema PATCH, the Collections manager, module switches,
// pack import, an approved proposal, a workspace module template, restore —
// reaches tag_schema through these two.
//
// They also hold the module-switch rule (D72): `behaviour.modules` (the legacy
// per-tag switch) changes only through PATCH /api/tags/:id/modules
// (tagModules.setTagModules) and the undo of such a change. Any other behaviour
// write keeps the switches stored now (keepModuleSwitches), and a new tag row
// starts without any: a new tag gets a module by extending the module's tag.
//   * changeTagSchema  — a recorded TAG_SCHEMA_UPDATED of some schema keys on a
//                        tag the caller has locked and authorised. A tag with no
//                        schema yet gets one (`whenNew`).
//
// Callers run these inside mutate().apply or withEventTransaction; q() joins
// the ambient transaction.

import { assertModuleTagEdge, assertParentKind } from "./parentKind.js";
import { isViewLayout } from "./viewLayouts.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { q, requireTransaction } from "../db.js";
import { mutate } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";
import { uniqueTagSlug } from "./nodes.js";
import { ATTRIBUTE_KEY_RULE, slugify } from "@onden/markdown";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { assertAuthority } from "../spine/authority.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { canSeeTag } from "./readPolicy.js";
import { assertFieldShapes, newOffGrammarFieldNames } from "./fieldSchema.js";
import { assertNoNewFieldClash } from "./tagFields.js";
import { AttributeWriteError, retypeGoverned } from "./attributeChange.js";
import { liveTagNodeSql, tagNodeSql } from "../spine/nodeSql.js";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

export type TagSchemaParts = {
  name: string;
  slug: string;
  fields?: unknown;
  views?: unknown;
  behaviour?: unknown;
  policy?: unknown;
  blockTemplate?: unknown;
  description?: string;
  version?: string;
  dependencies?: string[];
  templateChildren?: unknown;
  /** False keeps a capability-only tag out of the public collection payload.
   * Absent preserves the historical collection publication contract. */
  publishCollection?: boolean;
};

/** Canonical tag_schema jsonb shape. The single source of the object stored in
 *  content_nodes.tag_schema — every read site indexes these exact keys
 *  (tag_schema->'fields', ->>'name', …). Replaces the old SQL tag_schema_json(cs)
 *  builder dropped at CONTRACT. */
export function buildTagSchema(p: TagSchemaParts): Record<string, unknown> {
  return {
    name: p.name,
    slug: p.slug,
    fields: p.fields ?? [],
    policy: p.policy ?? {},
    behaviour: p.behaviour ?? {},
    template_children: p.templateChildren ?? [],
    views: p.views ?? {},
    block_template: p.blockTemplate ?? [],
    description: p.description ?? "",
    version: p.version ?? "1.0.0",
    dependencies: p.dependencies ?? [],
    ...(p.publishCollection === undefined ? {} : { publish_collection: p.publishCollection }),
  };
}

/** Which module switches a write may set. "keep" (every caller but two) keeps
 *  the stored `behaviour.modules`; "write" stores the given one, for
 *  setTagModules, which has judged the ids, and restore. */
export type ModuleSwitchWrite = "keep" | "write";

/** `behaviour` carrying the switches stored now instead of its own: what a
 *  behaviour write stores unless it may write switches. A stale editor or
 *  offline form that replaces the whole object neither erases nor changes
 *  them. Example: keepModuleSwitches({ review: {…}, modules: { nope: … } },
 *  { modules: { review: { enabled: true } } }) → { review: {…}, modules:
 *  { review: { enabled: true } } }. Anything but an object is returned as is
 *  . */
export function keepModuleSwitches(behaviour: unknown, stored: unknown): unknown {
  if (behaviour === null || typeof behaviour !== "object" || Array.isArray(behaviour)) return behaviour;
  const { modules: _dropped, ...rest } = behaviour as Record<string, unknown>;
  const kept = stored !== null && typeof stored === "object" && !Array.isArray(stored)
    && Object.hasOwn(stored, "modules") ? (stored as Record<string, unknown>).modules : undefined;
  return kept === undefined ? rest : { ...rest, modules: kept };
}

/** The `behaviour` keys of the retired tag automation (owner decision 2026-11-15:
 *  functions replaced it, AI skills are manual buttons). Rules already stored
 *  under them stay in tag_schema and nothing runs them; no write stores, changes
 *  or removes one. */
const RETIRED_AUTOMATION_KEYS = ["on_apply", "on_remove", "on_attribute_change"] as const;

/** How many retired automation keys `behaviour` carries (a backup restore
 *  reports it). */
export function countAutomation(behaviour: unknown): number {
  if (behaviour === null || typeof behaviour !== "object" || Array.isArray(behaviour)) return 0;
  return RETIRED_AUTOMATION_KEYS.filter((key) => (behaviour as Record<string, unknown>)[key] != null).length;
}

/** `schema` without the retired automation keys in its `behaviour`: a schema
 *  from an old backup, pack, proposal or client comes in as an ordinary one.
 *  Example: withoutAutomation({ behaviour: { on_apply: {…}, review: {…} } })
 *  → { behaviour: { review: {…} } }. */
export function withoutAutomation<T extends Record<string, unknown>>(schema: T): T {
  const behaviour = schema.behaviour;
  if (behaviour === null || typeof behaviour !== "object" || Array.isArray(behaviour)) return schema;
  if (!RETIRED_AUTOMATION_KEYS.some((key) => Object.hasOwn(behaviour, key))) return schema;
  const rest = Object.fromEntries(Object.entries(behaviour).filter(([key]) => !(RETIRED_AUTOMATION_KEYS as readonly string[]).includes(key)));
  return { ...schema, behaviour: rest };
}

/** `behaviour` with the automation keys the tag stores now put back: no write
 *  adds, changes or removes a stored rule (a cleanup migration is the owner's
 *  call), so an unrelated schema edit does not erase it either. */
function keepStoredAutomation(behaviour: unknown, stored: unknown): unknown {
  if (behaviour === null || typeof behaviour !== "object" || Array.isArray(behaviour)) return behaviour;
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return behaviour;
  const kept = Object.fromEntries(RETIRED_AUTOMATION_KEYS.filter((key) => (stored as Record<string, unknown>)[key] != null).map((key) => [key, (stored as Record<string, unknown>)[key]]));
  return { ...behaviour, ...kept };
}

/** Module marks that no longer exist. A schema written by an old backup, pack or client may still carry one; it is dropped on the way
 *  in, so such a tag comes back as an ordinary tag (read_later: migration 192, citations: 193). The view layouts (table, kanban,
 *  calendar, gallery) are here too: their module tags went with migration 196 — a view is a reference of a tag or note, never a tag.
 *  (review and tasks have no mark to drop here: their tags are not restored from a backup, backupRestore `review_tag` / `tasks_tag`.) */
const RETIRED_MODULES: readonly string[] = ["read_later", "citations"];
const isRetiredModule = (id: string): boolean => RETIRED_MODULES.includes(id) || isViewLayout(id);

export function withoutRetiredModules<T extends Record<string, unknown>>(schema: T): T {
  const marker = schema.module;
  const switches = (schema.behaviour as { modules?: Record<string, unknown> } | null | undefined)?.modules;
  const dropMarker = typeof marker === "string" && isRetiredModule(marker);
  const dropSwitches = switches !== null && typeof switches === "object" && Object.keys(switches).some(isRetiredModule);
  if (!dropMarker && !dropSwitches) return schema;
  const next: Record<string, unknown> = { ...schema };
  if (dropMarker) delete next.module;
  if (dropSwitches) {
    const kept = Object.fromEntries(Object.entries(switches!).filter(([id]) => !isRetiredModule(id)));
    next.behaviour = { ...(schema.behaviour as object), modules: kept };
  }
  return next as T;
}

export type NewTagRow = {
  /** Default: a fresh UUID. */
  id?: string;
  title: string;
  parentId?: string | null;
  /** null leaves the colour unset (the UI's default); omitted is #888888. */
  color?: string | null;
  schema?: Record<string, unknown> | null;
  reservedKey?: string | null;
  /** Default: a tag slug free in the workspace, from the title. Only a reserved
   *  tag names its own (it must not collide with a user tag of the same title). */
  slug?: string;
  /** "import": keep the field names as the imported data has them (see
   *  FieldNameRule). Default "judge". */
  fieldNames?: FieldNameRule;
};

/** How a schema write treats a NEW field name outside the attribute key
 *  grammar (D44: such a name's values are left out of an export, so they
 *  would not come back on re-import).
 *    "judge"  (every write but two) — refused with AttributeWriteError 400
 *             invalid_key, unless notes already store values under that key
 *             (promoting a key to a field names no new key). A name the
 *             schema already stores is never judged again.
 *    "import" — kept as the source has it: a database import (Notion / CSV
 *             columns such as "Due Date") stores its values under exactly
 *             those keys, and a backup restore puts back the schema it had.
 *             Normalising the name would split it from its values; the
 *             export's rule for such keys is documented in exportZip.ts.
 *  A tag pack, an agent's proposal and a module template are definitions,
 *  not data: they are judged. Event restore (`restoring`) is not judged. */
export type FieldNameRule = "judge" | "import";

/** Refuse a new off-grammar field name (FieldNameRule "judge"): the check
 *  the schema writers run, for a caller that wants the answer before queueing
 *  a write (an agent's pack proposal). `stored`: the fields the schema has. */
export async function assertFieldNamesAllowed(workspaceId: string, fields: unknown, stored: unknown): Promise<void> {
  const offGrammar = newOffGrammarFieldNames(fields, stored);
  if (!offGrammar.length) return;
  const inUse = new Set((await q<{ key: string }>(
    `SELECT DISTINCT key FROM node_attributes WHERE workspace_id = $1 AND key = ANY($2::text[])`,
    [workspaceId, offGrammar],
  )).rows.map((row) => row.key));
  const refused = offGrammar.find((name) => !inUse.has(name));
  if (refused !== undefined) {
    throw new AttributeWriteError(400, "invalid_key", `field name ${JSON.stringify(refused)} must be ${ATTRIBUTE_KEY_RULE}`);
  }
}

/** Insert one class_tag row. Throws the unique violation (23505) of a name or
 *  slug collision unchanged — callers map or adopt it — ParentKindError for a
 *  parent that is not a tag, ModuleTagParentError for a module tag with a
 *  parent or a parent that is a module tag, InvalidFieldError for a schema field without the
 *  field shape, and FieldNameClashError for a field its parent or functions
 *  already give (after the insert: the caller's transaction rolls it back),
 *  and AttributeWriteError 400 invalid_key for a field name outside the key
 *  grammar unless `fieldNames` is "import" (FieldNameRule).
 *  A schema's module switches are not stored (see keepModuleSwitches); a pack
 *  turns them into extends first (tagPacks.packModuleSwitches). */
export async function insertTagRow(
  workspaceId: string, row: NewTagRow,
): Promise<{ id: string; title: string; color: string | null }> {
  requireTransaction("insertTagRow");
  const given = row.schema ? withoutAutomation(withoutRetiredModules(row.schema)) : row.schema;
  const schema = given && Object.hasOwn(given, "behaviour")
    ? { ...given, behaviour: keepModuleSwitches(given.behaviour, undefined) } : given;
  assertFieldShapes(schema?.fields, []);
  if (row.fieldNames !== "import") await assertFieldNamesAllowed(workspaceId, schema?.fields, []);
  // A tag sits under a tag or at the root (services/parentKind.ts).
  await assertParentKind(workspaceId, TAG_NODE_TYPE, row.parentId ?? null);
  await assertModuleTagEdge(workspaceId, { isModule: typeof schema?.module === "string" }, row.parentId ?? null);
  const inserted = await q<{ id: string; title: string; color: string | null }>(
    `INSERT INTO content_nodes
       (id, workspace_id, source_type, node_type, title, slug, markdown,
        parent_id, tag_color, tag_schema, reserved_key)
     VALUES ($1, $2, 'manual', 'class_tag', $3, $4, '', $5, $6, $7::jsonb, $8)
     RETURNING id, title, tag_color AS color`,
    [
      row.id ?? randomUUID(), workspaceId, row.title,
      row.slug ?? await uniqueTagSlug(workspaceId, row.title),
      row.parentId ?? null,
      row.color === undefined ? "#888888" : row.color,
      schema ? JSON.stringify(schema) : null,
      row.reservedKey ?? null,
    ],
  );
  const tag = inserted.rows[0]!;
  // A module tag provides its own function (function_refs holds that as a row).
  await ensureModuleSelfRef(workspaceId, tag.id, schema?.module);
  // A new tag with fields under a parent, or extending a function, may declare
  // a name it already inherits (writeTagSchema's rule; the throw rolls back the
  // caller's transaction). With neither, nothing above it gives it a field.
  const declares = Array.isArray(row.schema?.fields) && row.schema.fields.length > 0;
  const inherits = !!row.parentId || (Array.isArray(row.schema?.extends) && row.schema.extends.length > 0);
  if (declares && inherits) await assertNoNewFieldClash(workspaceId, new Map([[tag.id, null]]));
  return tag;
}

// ── 模組標籤自己的引用（由 tagWrites 在 tag_schema.module 寫入時呼叫）──

/** 模組標籤自己提供它的功能：寫入 tag_schema.module 時補上自己的引用列（已有就不動）。
 *  視角模組標籤不在引用表（B2）。 */
export async function ensureModuleSelfRef(workspaceId: string, tagId: string, module: unknown): Promise<void> {
  if (typeof module !== "string" || module.length === 0 || module.length > 64 || isViewLayout(module)) return;
  await q(
    `INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [workspaceId, module, tagId],
  );
}

/** Write a live tag's tag_schema: `replace` sets it, `merge` overwrites only the
 *  given top-level keys (a tag with no schema stays without one — use replace).
 *  Returns the stored schema, or null when no live tag matched. Throws
 *  InvalidFieldError when a field this write adds or changes lacks the field
 *  shape; fields it keeps as they are stored are not re-judged,
 *  so a schema saved before the check stays saveable. A write of `fields`
 *  or `extends` that makes a tag declare a field name an ancestor gives (or an
 *  ancestor give one a descendant declares) throws FieldNameClashError (409,
 *  services/tagFields.ts) after the update, which rolls back the caller's
 *  transaction; a clash already stored is tolerated. A NEW field name
 *  outside the key grammar throws AttributeWriteError 400 invalid_key
 *  unless notes already use it or `fieldNames` is "import" (FieldNameRule,
 *  D100). `restoring` (event
 *  restore only) puts back a schema the tag had without that judgement. A
 *  behaviour write keeps the stored module switches unless `moduleSwitches`
 *  is "write" (setTagModules and restore, D72). */
export async function writeTagSchema(
  workspaceId: string, tagId: string,
  write: { replace: Record<string, unknown> } | { merge: Record<string, unknown> },
  { restoring = false, moduleSwitches = "keep", fieldNames = "judge" }: { restoring?: boolean; moduleSwitches?: ModuleSwitchWrite; fieldNames?: FieldNameRule } = {},
): Promise<Record<string, unknown> | null> {
  let next = withoutAutomation(withoutRetiredModules("replace" in write ? write.replace : write.merge));
  const writesFields = Object.hasOwn(next, "fields");
  // Only a write that adds names or ancestors can create a clash; a replace
  // without these keys drops them, which can only remove clashes.
  const judgesNames = !restoring && (writesFields || Object.hasOwn(next, "extends"));
  // Read for every write: the fields and `extends` before it also decide
  // whether stored values need retyping (below).
  const stored = (await q<{ behaviour: unknown; fields: unknown; extends: unknown }>(
    `SELECT tag_schema->'behaviour' AS behaviour, tag_schema->'fields' AS fields, tag_schema->'extends' AS extends
       FROM content_nodes
      WHERE workspace_id = $1 AND id = $2 AND ${tagNodeSql()}`,
    [workspaceId, tagId],
  )).rows[0];
  if (writesFields) assertFieldShapes(next.fields, stored?.fields);
  if (writesFields && !restoring && fieldNames === "judge") await assertFieldNamesAllowed(workspaceId, next.fields, stored?.fields);
  if (Object.hasOwn(next, "behaviour")) {
    if (moduleSwitches === "keep") next = { ...next, behaviour: keepModuleSwitches(next.behaviour, stored?.behaviour) };
    next = { ...next, behaviour: keepStoredAutomation(next.behaviour, stored?.behaviour) };
  }
  const result = await q<{ tag_schema: Record<string, unknown> }>(
    "replace" in write
      ? `UPDATE content_nodes SET tag_schema = $3::jsonb, updated_at = now()
          WHERE workspace_id = $1 AND id = $2 AND ${liveTagNodeSql()}
          RETURNING tag_schema`
      : `UPDATE content_nodes SET tag_schema = tag_schema || $3::jsonb, updated_at = now()
          WHERE workspace_id = $1 AND id = $2 AND ${liveTagNodeSql()}
          RETURNING tag_schema`,
    [workspaceId, tagId, JSON.stringify(next)],
  );
  const written = result.rows[0]?.tag_schema ?? null;
  if (written) await ensureModuleSelfRef(workspaceId, tagId, written.module);
  const namesChanged = (key: "fields" | "extends") => !isDeepStrictEqual(written?.[key] ?? [], stored?.[key] ?? []);
  if (written && judgesNames && (namesChanged("fields") || namesChanged("extends"))) {
    await assertNoNewFieldClash(workspaceId, new Map([[tagId, { fields: stored?.fields ?? [], extends: stored?.extends ?? [] }]]));
  }
  // A field's type, a field or an extended tag come or go: the values of the
  // tag's notes and of the tags inheriting from it follow (D94).
  if (written && (namesChanged("fields") || namesChanged("extends"))) await retypeGoverned(workspaceId, { tagIds: [tagId] });
  return written;
}

export type LockedTag = { id: string; title: string; tag_schema: Record<string, unknown> | null };

/** Record and apply a change to some schema keys of a tag the caller has
 *  already locked (FOR UPDATE) and authorised. The event is TAG_SCHEMA_UPDATED
 *  with the changed keys' previous values, so restore can undo exactly them.
 *  A tag without a schema gets one: `collection` is a published collection
 *  slugged from its name; `private` serves tag functions only, with a UUID slug.
 *  Returns the stored schema. */
export async function changeTagSchema(input: {
  actor: ActorCtx;
  workspaceId: string;
  tag: LockedTag;
  patch: Record<string, unknown>;
  whenNew: "collection" | "private";
  uiContext: string;
  /** "write" only for setTagModules (writeTagSchema). */
  moduleSwitches?: ModuleSwitchWrite;
  /** "import" only for a backup restore (FieldNameRule). */
  fieldNames?: FieldNameRule;
}): Promise<Record<string, unknown>> {
  const { actor, workspaceId, tag } = input;
  // Record what is stored: a behaviour patch keeps the switches (D72).
  const patch = input.moduleSwitches !== "write" && Object.hasOwn(input.patch, "behaviour")
    ? { ...input.patch, behaviour: keepModuleSwitches(input.patch.behaviour, tag.tag_schema?.behaviour) }
    : input.patch;
  const changed = Object.keys(patch);
  return mutate({
    actor, workspaceId, authority: { kind: "principal_admin" },
    // A collection's schema shapes what the published site serves.
    visibilityChanged: [tag.id],
    event: {
      type: "TAG_SCHEMA_UPDATED", targetType: "tag", targetId: tag.id,
      payload: { changed, next_field_values: patch, created: !tag.tag_schema },
      txMeta: {
        inverse_op: "tag_schema.updated",
        prev_field_values: tag.tag_schema
          ? Object.fromEntries(changed.map((key) => [key, tag.tag_schema![key] ?? null]))
          : null,
        ui_context: input.uiContext,
      },
    },
    apply: async () => {
      // writeTagSchema refuses a same-name field this patch would create.
      const stored = await writeTagSchema(workspaceId, tag.id, { replace: { ...schemaBase(tag, input.whenNew), ...patch } },
        { moduleSwitches: input.moduleSwitches, fieldNames: input.fieldNames });
      if (!stored) throw new Error(`tag ${tag.id} vanished while locked`);
      return stored;
    },
  });
}

/** The schema a change starts from: the stored one, or the one a tag without
 *  a schema gets (changeTagSchema `whenNew`). */
function schemaBase(tag: LockedTag, whenNew: "collection" | "private"): Record<string, unknown> {
  return tag.tag_schema ?? (whenNew === "collection"
    ? buildTagSchema({ name: tag.title, slug: slugify(tag.title) })
    : buildTagSchema({ name: tag.title, slug: `module-${tag.id}`, publishCollection: false }));
}

/** The owner's edit of some top-level keys of a tag's schema — the one door
 *  behind PATCH /api/tags/:id/schema (D100).
 *  Under the event lock: the CURRENT actor must be principal admin (else the
 *  authority error), the tag must be live and visible to it (else null). A
 *  `behaviour` keeps the stored module switches (D72). Only keys whose value
 *  differs from what is stored are written, as one TAG_SCHEMA_UPDATED that
 *  restore undoes key by key; nothing differing writes nothing. A tag without
 *  a schema gets a published collection's. Each value is judged where it is
 *  written (writeTagSchema): field shape, field names (D44), same-name
 *  fields (D93).
 *
 *    await patchTagSchema({ actor, workspaceId, tagId, patch: { fields }, uiContext: "tag.schema.patch" })
 *    → { schema, changed: ["fields"] }  (schema: as stored now; null when the
 *      tag has none and nothing changed) */
export async function patchTagSchema(input: {
  actor: ActorCtx;
  workspaceId: string;
  tagId: string;
  /** Top-level keys to set; undefined values are left out. */
  patch: Record<string, unknown>;
  uiContext: string;
}): Promise<{ schema: Record<string, unknown> | null; changed: string[] } | null> {
  const { workspaceId, tagId } = input;
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    await assertAuthority(actor, { kind: "principal_admin" });
    if (!(await canSeeTag(actor, tagId))) return null;
    const tag = (await q<LockedTag>(
      `SELECT id::text, title, tag_schema FROM content_nodes
        WHERE workspace_id = $1 AND id = $2 AND ${liveTagNodeSql()} FOR UPDATE`,
      [workspaceId, tagId],
    )).rows[0];
    if (!tag) return null;
    const patch = Object.fromEntries(Object.entries(input.patch).filter(([, value]) => value !== undefined));
    // Older editors and durable offline writes replace the whole behaviour
    // object; judge "unchanged" on what would be stored (D72).
    if (Object.hasOwn(patch, "behaviour")) patch.behaviour = keepModuleSwitches(patch.behaviour, tag.tag_schema?.behaviour);
    const base = schemaBase(tag, "collection");
    const changed = Object.keys(patch).filter((key) => !isDeepStrictEqual(patch[key], base[key] ?? null));
    if (!changed.length) return { schema: tag.tag_schema, changed };
    const schema = await changeTagSchema({
      actor, workspaceId, tag, patch: Object.fromEntries(changed.map((key) => [key, patch[key]])),
      whenNew: "collection", uiContext: input.uiContext,
    });
    return { schema, changed };
  });
}
