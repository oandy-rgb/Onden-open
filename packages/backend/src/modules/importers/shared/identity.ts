import { sha256Hex } from "../../../utils.js";
import { freeFormType } from "@onden/markdown";
import { q } from "../../../db.js";
import { db } from "../../../dbKysely.js";

const KEPT_OFF_STAMP_KEY = "_import_kept_off";
import { readableScopeSql } from "../../../services/readPolicy.js";
import { isPersonAuthored } from "../../../spine/attributeSource.js";
import type { ActorCtx } from "../../../types.js";
import type { ImportSource } from "@onden/contract";
import { liveNodeSql } from "../../../spine/nodeSql.js";

export type ImportedNode = {
  id: string; title: string; markdown: string; slug: string;
  parent_id: string | null; deleted_at: string | null; baseline: string | null;
};

// Source identity comes from an import creation event, not an editable title or
// copied attribute. "legacy" is an explicit compatibility namespace; it never
// adopts nodes from a named source. Callers keep their authority/event lock.
const creation = `e.event_type='NODE_CREATED' AND e.target_id=n.id::text AND e.workspace_id=n.workspace_id`;
const sourceMatch = `COALESCE(e.tx_meta->>'import_source_id','legacy')=$3`;

export function importSourceMeta(source: ImportSource) {
  return { import_source_id: source.id, import_source_name: source.name };
}

export async function findImportedNotes(workspaceId: string, source: ImportSource, path: string) {
  return (await q<ImportedNode>(`SELECT n.id,n.title,n.markdown,n.slug,n.parent_id,n.deleted_at,
    (SELECT value FROM node_attributes WHERE node_id=n.id AND key='_import_baseline' AND source='derived') AS baseline
    FROM content_nodes n JOIN node_attributes p ON p.node_id=n.id AND p.key='_import_path'
    WHERE n.workspace_id=$1 AND p.value=$2 AND p.source='derived'
      AND EXISTS (SELECT 1 FROM domain_events e WHERE ${creation} AND ${sourceMatch}
        AND e.tx_meta->>'ui_context'='import.obsidian') LIMIT 2`, [workspaceId,path,source.id])).rows;
}

export async function findImportedFolders(workspaceId: string, source: ImportSource, path: string, name: string, parentId: string | null) {
  return (await q<Pick<ImportedNode,"id" | "parent_id" | "deleted_at">>(`SELECT n.id,n.parent_id,n.deleted_at
    FROM content_nodes n LEFT JOIN node_attributes p ON p.node_id=n.id AND p.key='_import_folder_path'
    WHERE n.workspace_id=$1
      AND ((p.value=$2 AND p.source='derived') OR ($3='legacy' AND p.node_id IS NULL
        AND n.title=$4 AND n.parent_id IS NOT DISTINCT FROM $5::uuid))
      AND EXISTS (SELECT 1 FROM domain_events e WHERE ${creation} AND ${sourceMatch}
        AND e.tx_meta->>'ui_context'='import.obsidian.folder') LIMIT 2`, [workspaceId,path,source.id,name,parentId])).rows;
}

/** Lists only source labels backed by currently readable live imported nodes.
 * Names are display labels: even two identically named sources have separate IDs. */
export async function listImportSources(actor: ActorCtx, workspaceId: string): Promise<ImportSource[]> {
  const params: unknown[] = [workspaceId];
  const scope = readableScopeSql(actor, "n", params);
  const rows = await q<ImportSource>(`SELECT DISTINCT COALESCE(e.tx_meta->>'import_source_id','legacy') AS id,
    COALESCE(e.tx_meta->>'import_source_name','Older imports') AS name
    FROM content_nodes n JOIN domain_events e ON ${creation}
    WHERE n.workspace_id=$1 AND ${liveNodeSql("n")}
      AND e.tx_meta->>'ui_context' IN ('import.obsidian','import.obsidian.folder') AND ${scope}
    ORDER BY name,id`, params);
  // A source's initial label may differ between old requests; one selectable ID.
  return [...new Map(rows.rows.map(row => [row.id,row])).values()];
}

/** Stamp only inside the importing node's event transaction, after body-derived
 * attributes/cascades. The baseline compares state, not timestamps or row IDs;
 * a no-op reimport must not approve unrelated edits by advancing this baseline. */
export async function stampImportedNote(workspaceId: string, nodeId: string, source: ImportSource, path: string, keptOffFile: string | null = null) {
  await stamp(workspaceId,nodeId,"_import_path",path);
  // Which file version's 「不發布」 was applied (stampKeptOffApplied); a file that no longer says it forgets it.
  if (keptOffFile === null) await db.deleteFrom("node_attributes").where("node_id", "=", nodeId).where("key", "=", KEPT_OFF_STAMP_KEY).execute();
  else await stampKeptOffApplied(workspaceId, nodeId, keptOffFile);
  await stamp(workspaceId,nodeId,"_import_source_id",source.id);
  await stamp(workspaceId,nodeId,"_import_baseline",await importedStateHash(workspaceId,nodeId));
  // The pre-repair types only reproduced the old stamp, now replaced.
  await q(`DELETE FROM node_attributes WHERE node_id=$1 AND key='_import_retyped'`, [nodeId]);
}

/** An import that read `publish: false` marks the note 「不發布」 once per file version: a person who later puts the note
 *  back on the site (the mark removed) is not reversed by importing the same, unchanged file again. `fileText` is the
 *  whole file as imported. */
export async function stampKeptOffApplied(workspaceId: string, nodeId: string, fileText: string) {
  await stamp(workspaceId, nodeId, KEPT_OFF_STAMP_KEY, sha256Hex(fileText));
}
export async function keptOffAppliedFor(nodeId: string, fileText: string): Promise<boolean> {
  const row = await db.selectFrom("node_attributes").select("value").where("node_id", "=", nodeId).where("key", "=", KEPT_OFF_STAMP_KEY).executeTakeFirst();
  return row?.value === sha256Hex(fileText);
}

export async function stampImportedFolder(workspaceId: string, nodeId: string, source: ImportSource, path: string) {
  await stamp(workspaceId,nodeId,"_import_folder_path",path);
  await stamp(workspaceId,nodeId,"_import_source_id",source.id);
}

// `_import_` keys have no schema field: the type follows the value
// (@onden/markdown freeFormType), like any other value no writer typed.
function stamp(workspaceId: string, nodeId: string, key: string, value: string) {
  return q(`INSERT INTO node_attributes(workspace_id,node_id,key,value,value_type,is_inheritable,source)
    VALUES($1,$2,$3,$4,$5,false,'derived') ON CONFLICT(node_id,key)
    DO UPDATE SET value=EXCLUDED.value,value_type=EXCLUDED.value_type,source='derived',updated_at=now()`,
    [workspaceId,nodeId,key,value,freeFormType(value)]);
}

/** The state an import baseline records. Only attributes a person authored
 *  are in it (isPersonAuthored): ones derived from the body (markdown or
 *  dispatcher: inline `key:: value`, behaviours) are left out because the
 *  body is already in the hash and they are written after commit, so
 *  including them made the next re-import see "local changes" that were only
 *  the derivation catching up; values Onden computes (derived) are no change
 *  a person made either. */
async function importedStateHash(workspaceId: string, nodeId: string): Promise<string> {
  return (await importedStateHashes(workspaceId, nodeId)).current;
}

/** The current baseline hash, and the older forms still accepted when
 *  comparing, so a baseline stamped before a change does not refuse its next
 *  re-import:
 *   * current (D106): only person-authored attributes, without value_type;
 *   * D21 until D106: without value_type — the type follows from the schema
 *     field and the value (@onden/markdown attributeValue), it is not state a
 *     person changed, so a retype by that rule is no "local change";
 *   * until D21: with value_type, using the type each row had before
 *     migration 105 retyped it (`_import_retyped`, {key: old type});
 *   * before 2026-10-14: that, also hashing body-derived attributes. */
export async function importedStateHashes(workspaceId: string, nodeId: string): Promise<{ current: string; accepted: string[] }> {
  const node = (await q(`SELECT title,markdown,parent_id,node_type FROM content_nodes WHERE workspace_id=$1 AND id=$2`, [workspaceId,nodeId])).rows[0];
  if (!node) throw new Error("Imported node disappeared within its transaction");
  type Row = { key: string; value: string; value_type: string; is_inheritable: boolean; source: string };
  const attrs = (await q<Row>(`SELECT key,value,value_type,is_inheritable,source FROM node_attributes
    WHERE workspace_id=$1 AND node_id=$2 AND left(key,8)<>'_import_' ORDER BY key`, [workspaceId,nodeId])).rows;
  const retypedRaw = (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id=$1 AND key='_import_retyped'`, [nodeId])).rows[0]?.value;
  let before: Record<string, string> = {};
  try { before = retypedRaw ? JSON.parse(retypedRaw) as Record<string, string> : {}; } catch { before = {}; }
  const tags = (await q(`SELECT tag_id FROM node_tags WHERE node_id=$1 ORDER BY tag_id`, [nodeId])).rows;
  const hash = (a: unknown[]) => sha256Hex(JSON.stringify({ node, attrs: a, tags }));
  // A person's values (isPersonAuthored, D106): the same rule as the zip
  // export and a duplicate. Until D106 this was "all but markdown and
  // dispatcher", so values Onden computes (derived defaults) counted too.
  const own = (rows: Row[]) => rows.filter((a) => isPersonAuthored(a.source));
  const notBodyDerived = (rows: Row[]) => rows.filter((a) => a.source !== "markdown" && a.source !== "dispatcher");
  const untyped = (rows: Row[]) => rows.map(({ key, value, is_inheritable, source }) => ({ key, value, is_inheritable, source }));
  // Same field order as the old SELECT row, so the old stamps reproduce.
  const typedAsBefore = (rows: Row[]) => rows.map(({ key, value, value_type, is_inheritable, source }) =>
    ({ key, value, value_type: before[key] ?? value_type, is_inheritable, source }));
  const current = hash(untyped(own(attrs)));
  return { current, accepted: [current, hash(untyped(notBodyDerived(attrs))), hash(typedAsBefore(notBodyDerived(attrs))), hash(typedAsBefore(attrs))] };
}
