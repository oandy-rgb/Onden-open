// Field inheritance (docs/architecture/module-library.md, phase 2b): the fields
// notes with a tag get are its own plus those of the tags it inherits from, at
// any depth — (1) its parent tags (上層: #書/小說 gets #書's fields; the user,
// 2026-10-18: 「繼承就是原本的子節點」), (2) the module tags of its functions
// (`extends`), and (3) legacy tag→tag `extends`, kept until removed so nobody
// loses fields. For a name both declare, the nearest declaration wins — the
// tag's own first, then breadth-first, the parent before the extended tags at
// each step. Nothing is copied: a change to an ancestor's fields reaches every
// tag that inherits them. Missing tags, non-tag parents and cycles add nothing.
//
// Every reader that asks "which fields does this tag give" goes through here —
// value validation (schemaValidation.fieldForKey), defaults seeded on apply,
// rollups, a saved view's field types, and the catalog the client receives
// (`effective_fields`), so the server and the app agree.

import { newFieldNameClashes, type FieldClash } from "@onden/markdown";
import { q } from "../db.js";
import type { StoredFieldDef } from "./schemaValidation.js";
import { extendsIdsOf } from "./tagExtendsList.js";
import { liveTagNodeSql } from "../spine/nodeSql.js";

export type TagFieldRow = { id: string; parent_id?: string | null; extends: unknown; fields: unknown };

/** A field as a tag gives it; `inherited_from` names the tag that declares
 *  it when that is not the tag itself. */
export type EffectiveField = StoredFieldDef & { inherited_from?: string };

function ownFields(value: unknown): StoredFieldDef[] {
  return Array.isArray(value)
    ? value.filter((f): f is StoredFieldDef => !!f && typeof f === "object" && typeof (f as StoredFieldDef).name === "string" && (f as StoredFieldDef).name !== "")
    : [];
}

/** Every tag's effective fields, keyed by tag id. */
export function effectiveTagFields(rows: TagFieldRow[]): Map<string, EffectiveField[]> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result = new Map<string, EffectiveField[]>();
  for (const row of rows) {
    const fields: EffectiveField[] = [];
    const names = new Set<string>();
    const seen = new Set([row.id]);
    for (let level = [row.id]; level.length;) {
      const next: string[] = [];
      for (const id of level) {
        const tag = byId.get(id);
        if (!tag) continue;
        for (const field of ownFields(tag.fields)) {
          if (names.has(field.name)) continue;
          names.add(field.name);
          fields.push(id === row.id ? field : { ...field, inherited_from: id });
        }
        for (const parent of [...(tag.parent_id ? [tag.parent_id] : []), ...extendsIdsOf(tag.extends)]) {
          if (!seen.has(parent)) { seen.add(parent); next.push(parent); }
        }
      }
      level = next;
    }
    result.set(row.id, fields);
  }
  return result;
}

/** The live tags' field inputs. `q` joins the caller's transaction, so a tag
 *  created or changed earlier in the same operation is seen. */
export async function loadTagFieldRows(workspaceId: string): Promise<TagFieldRow[]> {
  return (await q<TagFieldRow>(
    `SELECT id, parent_id::text AS parent_id, tag_schema->'extends' AS extends, tag_schema->'fields' AS fields
       FROM content_nodes WHERE workspace_id = $1 AND ${liveTagNodeSql()}`,
    [workspaceId],
  )).rows;
}

/** One tag's effective fields (empty for a missing tag). */
export async function effectiveFieldsOf(workspaceId: string, tagId: string): Promise<EffectiveField[]> {
  return effectiveTagFields(await loadTagFieldRows(workspaceId)).get(tagId) ?? [];
}

// Same-name fields are refused (the user, 2026-10-18: 「同名欄位要不要禁止」→「要」):
// a tag may not declare a field name one of its ancestors (parents, functions,
// extended tags, at any depth) already gives. The rule itself — names only,
// labels do not count — is @onden/markdown's fieldNameClashes, which the app's
// field editor asks too. Here it guards every write: the check compares the
// state before and after the write and refuses only clashes the write
// creates, so legacy or restored data that already clashes keeps working
// (nearest wins) and can still be edited.
//
// The gate is the two schema writers (tagWrites insertTagRow and
// writeTagSchema, which every schema write — the schema PATCH, the Collections
// manager, module switches, pack import, an approved proposal — goes through),
// plus the parent moves (nodeTree.assertReparent: nodeUpdate, tagMerge and
// the undo of a move). Restore writes the schema it
// had and is not judged (docs/architecture/module-library.md).

export { fieldNameClashes, type FieldClash } from "@onden/markdown";

export class FieldNameClashError extends Error {
  readonly code = "field_name_inherited";
  constructor(public clashes: Array<FieldClash & { tag_title: string; from_title: string }>) {
    super(clashes.map((c) => `#${c.from_title} already gives the field "${c.field}" to #${c.tag_title}`).join("; "));
  }
}

type FieldInputs = Partial<Pick<TagFieldRow, "parent_id" | "extends" | "fields">>;

/** Refuse a write to tags' fields, parent or `extends` that made a tag declare
 *  a field an ancestor already gives. Call inside the write's transaction,
 *  after the write; `previous` maps each changed tag id → its values before
 *  (absent keys were unchanged), or → null for a tag the write created. The
 *  throw rolls the write back. */
export async function assertNoNewFieldClash(workspaceId: string, previous: Map<string, FieldInputs | null>): Promise<void> {
  const after = await loadTagFieldRows(workspaceId);
  const before = after.filter((row) => previous.get(row.id) !== null).map((row) => ({ ...row, ...previous.get(row.id) }));
  await refuseNewClashes(workspaceId, before, after);
}

/** The same check before a write: `next` maps each tag id → its proposed values. */
export async function assertFieldChangeAllowed(workspaceId: string, next: Map<string, FieldInputs>): Promise<void> {
  const before = await loadTagFieldRows(workspaceId);
  await refuseNewClashes(workspaceId, before, before.map((row) => ({ ...row, ...next.get(row.id) })));
}

async function refuseNewClashes(workspaceId: string, before: TagFieldRow[], after: TagFieldRow[]): Promise<void> {
  const fresh = newFieldNameClashes(before, after);
  if (!fresh.length) return;
  const ids = [...new Set(fresh.flatMap((c) => [c.tag, c.from]))];
  const titles = new Map((await q<{ id: string; title: string }>(
    `SELECT id::text AS id, title FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
    [workspaceId, ids],
  )).rows.map((row) => [row.id, row.title]));
  throw new FieldNameClashError(fresh.map((c) => ({ ...c, tag_title: titles.get(c.tag) ?? "", from_title: titles.get(c.from) ?? "" })));
}
