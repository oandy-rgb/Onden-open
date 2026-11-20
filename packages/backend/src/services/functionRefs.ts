// 功能引用表的唯一入口（docs/architecture/proposals/function-references-2026-11-02.md §3.5，B1）。
//
// 「這個東西有什麼功能」只問這裡：
//   讀  functionsOf(actor, holder)          一個引用者的有效功能（含來源與設定）
//       functionIndex(actor, workspaceId)   一次載入全部標籤的有效功能，給批次判斷用
//   寫  addFunction / removeFunction / setFunctionConfig
//       事件 FUNCTION_REF_ADDED／REMOVED／CONFIG_CHANGED（target 是引用者標籤），可由 restoreEvent 復原。
//
// 寫（addFunction 等）只有標籤層：引用者是標籤節點，要 principal_admin（與舊的 setTagModules 一致）。
// 筆記當引用者（B3）：任務節點在建立時由 insertFunctionRefs 記一筆 'tasks'（事件是建立節點的事件，不另記），
// functionsOf 讀得到；使用者不能加減它。
// 空間引用的表欄位已建好，但 B4 才開放（addFunction 拒絕）。
//
// 一個標籤的有效功能＝它自己的引用。舊的「extends 取得」已在遷移 166 攤平成它自己的引用
// （業主 2026-11-02 第 1 題）；設定來自哪個標籤記在 config.source_tag_id（沒有＝標籤自己）。
//
// 已存檢視（B2）也是引用：holder_node_id 是標籤或筆記，function_id 是版面（table／kanban／calendar／
// gallery／canvas／slides），instance 是檢視 id，config 是名稱、篩選、排序、釘選順序、版面參數。
// 標籤與筆記用同一組函式（viewRecordsOf、insertView、patchView、removeView）；tagViews.ts、noteViews.ts 只管
// 各自的權限、事件與路由形狀。有 instance 的引用才是檢視，沒有 instance 的是一般功能。
// 一個標籤有某版面的檢視，就有那個版面的功能（取代舊的「extends 視角模組標籤」）。
//
// 過渡接縫（B3 刪除，ratchet 只減不增）：tag_schema.extends 還同步維護一份（只為成員查詢與欄位繼承），
// 功能是否存在一律以引用表為準。tag_schema.module／extends 作為「功能」讀的地方只准在這個檔案。

import { isUuid } from "@onden/markdown";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import { q, requireTransaction } from "../db.js";
import { db } from "../dbKysely.js";
import type { JsonObject } from "../dbSchema.generated.js";
import type { ActorCtx } from "../types.js";
import { mutate } from "../spine/mutate.js";
import { assertAuthority, carriedActorId } from "../spine/authority.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { StatusError } from "../statusError.js";
import { canReadNode, canSeeTag } from "./readPolicy.js";
import { isViewLayout, viewLayouts, WHITEBOARD_LAYOUT } from "./viewLayouts.js";
import { extendsIdsOf } from "./tagExtendsList.js";
import { buildTagSchema, writeTagSchema } from "./tagWrites.js";
import {
  registerRestoreHandler,
  type EventRow, type RestoreContext, type RestoreError, type RestoreResult,
} from "./restoreContract.js";
import { liveNodeSql, liveTagNodeSql } from "../spine/nodeSql.js";
import { CONTENT_LAYOUT, TAG_NODE_TYPE, isTag } from "@onden/markdown/contract";

// ── 型別 ────────────────────────────────────────────────────────────────────

/** 誰引用功能。node 是標籤或筆記（任務節點、複習卡）；空間 B4。段落的引用（複習卡）隨內文存檔，不是功能事件的對象，見 OwnRefHolder。 */
export type FunctionHolder = { kind: "node"; id: string } | { kind: "space"; id: string };

export type FunctionUse = {
  /** 引用列的 id；檢視（有 instance 的引用）不是使用者加減的功能，沒有，為 null。 */
  refId: string | null;
  functionId: string;
  instance: string;
  config: Record<string, unknown>;
  holder: FunctionHolder;
  /** 設定來自哪個標籤（模組標籤）；等於引用者自己時就是「自己的」。 */
  sourceTagId: string;
};

export class FunctionRefError extends StatusError {
  constructor(status: 400 | 404 | 409 = 404, message = "tag not found") {
    super(status, message);
    this.name = "FunctionRefError";
  }
}

// 由 mountModules 依 ModuleDefinition.tagFunction 填入——核心不列模組 id。
// 已儲存但未登錄的功能 id 原樣保留（同舊規則）。
const registered = new Set<string>();

export function registerFunctionId(id: string): void {
  registered.add(id);
}

/** 已登錄的功能 id，依登錄順序。 */
export function registeredFunctionIds(): string[] {
  return [...registered];
}

/** A JSON object value, or {} for anything else (null, array, scalar). */
export function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// ── 讀 ──────────────────────────────────────────────────────────────────────

type TagRow = { id: string; module: unknown; extends: unknown; behaviour: unknown };
type RefRow = { id: string; function_id: string; instance: string; config: Record<string, unknown>; holder_node_id: string };

const LIVE_TAGS_SQL = `SELECT id, tag_schema->>'module' AS module, tag_schema->'extends' AS extends, tag_schema->'behaviour' AS behaviour
  FROM content_nodes WHERE workspace_id = $1 AND ${liveTagNodeSql()}`;

async function liveTags(workspaceId: string): Promise<TagRow[]> {
  return (await q<TagRow>(LIVE_TAGS_SQL, [workspaceId])).rows;
}

function sourceOf(row: RefRow): string {
  const source = row.config.source_tag_id;
  return typeof source === "string" && isUuid(source) ? source : row.holder_node_id;
}

function useOf(row: RefRow): FunctionUse {
  return {
    refId: row.instance === "" ? row.id : null, functionId: row.function_id, instance: row.instance, config: row.config,
    holder: { kind: "node", id: row.holder_node_id }, sourceTagId: sourceOf(row),
  };
}

/** 目前還走舊讀法、把 tag_schema.extends 當「功能」讀的點數量（ratchet：只減不增；守門測試比對）。 */
export const LEGACY_FUNCTION_READS = 0;

export type FunctionIndex = {
  /** 每個 live 標籤的有效功能（沒有功能的標籤不在裡面）。 */
  byTag: ReadonlyMap<string, readonly FunctionUse[]>;
  /** 標籤的有效功能 id（引用表的與視角的）。 */
  idsOf(tagId: string): string[];
  has(tagId: string, functionId: string): boolean;
  /** 設定來自哪個標籤；沒有這個功能就是 null。 */
  sourceOf(tagId: string, functionId: string): string | null;
  /** 有這個功能的標籤 id。 */
  tagsWith(functionId: string): string[];
};

function indexOf(byTag: Map<string, FunctionUse[]>): FunctionIndex {
  const find = (tagId: string, functionId: string) => byTag.get(tagId)?.find((use) => use.functionId === functionId);
  return {
    byTag,
    idsOf: (tagId) => [...new Set((byTag.get(tagId) ?? []).map((use) => use.functionId))],
    has: (tagId, functionId) => !!find(tagId, functionId),
    sourceOf: (tagId, functionId) => find(tagId, functionId)?.sourceTagId ?? null,
    tagsWith: (functionId) => [...byTag].filter(([, uses]) => uses.some((use) => use.functionId === functionId)).map(([id]) => id),
  };
}

/** 一次載入工作區全部 live 標籤的有效功能（取代 loadTagAbilities＋effectiveTagModules）。
 *  標籤定義是全域的（docs/architecture/spaces.md），所以不依 actor 過濾；
 *  呼叫者在自己的讀取快照或事件交易內執行。 */
export async function functionIndex(_actor: ActorCtx | null, workspaceId: string): Promise<FunctionIndex> {
  const tags = await liveTags(workspaceId);
  const live = new Set(tags.map((tag) => tag.id));
  // 檢視只在「版面是已登錄的檢視版面」時算功能，且不帶設定（一個標籤可有很多檢視，目錄不需要它們的篩選）。
  const refs = (await q<RefRow>(
    `SELECT r.id::text, r.function_id, r.instance,
            CASE WHEN r.instance = '' THEN r.config ELSE '{}'::jsonb END AS config, r.holder_node_id::text
       FROM function_refs r JOIN content_nodes n ON n.id = r.holder_node_id
      WHERE r.workspace_id = $1 AND ${liveTagNodeSql("n")}
        AND (r.instance = '' OR r.function_id = ANY($2::text[]))
      ORDER BY r.created_at, r.function_id, r.id`,
    [workspaceId, viewLayouts()],
  )).rows;
  const byTag = new Map<string, FunctionUse[]>();
  const push = (tagId: string, use: FunctionUse) => byTag.set(tagId, [...(byTag.get(tagId) ?? []), use]);
  for (const row of refs) {
    // 設定來源的標籤已不存在（或在垃圾桶）：和舊的 extends 指向不存在標籤一樣，不提供功能。
    if (!live.has(sourceOf(row))) continue;
    push(row.holder_node_id, useOf(row));
  }
  return indexOf(byTag);
}

/** 一個引用者的有效功能；看不到這個節點（或不存在）回 null。空間還沒有引用，回 []。
 *  引用者可以是標籤，也可以是筆記（B3：任務節點引用 'tasks'）；筆記的引用沒有設定來源，來源就是它自己。 */
export async function functionsOf(actor: ActorCtx, holder: FunctionHolder): Promise<FunctionUse[] | null> {
  if (holder.kind === "space") return [];
  if (!isUuid(holder.id)) return null;
  const node = (await q<{ node_type: string }>(
    `SELECT node_type FROM content_nodes WHERE id = $1 AND ${liveNodeSql()}`, [holder.id],
  )).rows[0];
  if (!node) return null;
  if (!isTag(node)) {
    if (!(await canReadNode(actor, holder.id))) return null;
    const rows = await db.selectFrom("function_refs").select(["id", "function_id", "instance", "config", "holder_node_id"])
      .where("holder_node_id", "=", holder.id).where("instance", "=", "").orderBy("created_at").orderBy("function_id").orderBy("id").execute();
    return rows.map((row) => ({ ...useOf(row as RefRow), sourceTagId: row.holder_node_id! }));
  }
  if (!(await canSeeTag(actor, holder.id))) return null;
  const refs = (await q<RefRow>(
    `SELECT id::text, function_id, instance, CASE WHEN instance = '' THEN config ELSE '{}'::jsonb END AS config, holder_node_id::text
       FROM function_refs WHERE holder_node_id = $1 AND (instance = '' OR function_id = ANY($2::text[]))
      ORDER BY created_at, function_id, id`, [holder.id, viewLayouts()],
  )).rows;
  const sources = [...new Set(refs.map(sourceOf))];
  const live = new Set((await q<{ id: string }>(
    `SELECT id::text FROM content_nodes WHERE id = ANY($1::uuid[]) AND ${liveTagNodeSql()}`, [sources],
  )).rows.map((row) => row.id));
  return refs.filter((row) => live.has(sourceOf(row))).map(useOf);
}

/** 是否有任何 live 標籤提供這個功能（模組庫「使用中」的預設判斷）。 */
export async function functionInUse(workspaceId: string, functionId: string): Promise<boolean> {
  return (await q(
    `SELECT 1 FROM function_refs r JOIN content_nodes n ON n.id = r.holder_node_id
      WHERE r.workspace_id = $1 AND r.function_id = $2 AND r.instance = '' AND ${liveTagNodeSql("n")} LIMIT 1`,
    [workspaceId, functionId],
  )).rowCount! > 0;
}

/** 自己提供這個功能的 live 標籤（不含只因延伸模組標籤而得到的）目前的名稱（小寫，不看讀取權限），以及工作區裡是否另有一個名叫 `word`、
 *  不提供它的 live 標籤。用名稱當保留字的功能（任務的 `{task}`）靠這個認字。 */
export async function functionTagNames(workspaceId: string, functionId: string, word: string): Promise<{ names: string[]; otherTagNamed: boolean }> {
  const rows = await db.selectFrom("content_nodes as n")
    .leftJoin("function_refs as r", (join) => join.onRef("r.holder_node_id", "=", "n.id").on("r.function_id", "=", functionId).on("r.instance", "=", "").on(sql<boolean>`NOT (r.config ? 'source_tag_id')`))
    .select([sql<string>`lower(n.title)`.as("title"), sql<boolean>`r.id IS NOT NULL`.as("provides")])
    .where("n.workspace_id", "=", workspaceId).where("n.node_type", "=", TAG_NODE_TYPE).where("n.deleted_at", "is", null)
    .where(sql<boolean>`(r.id IS NOT NULL OR lower(n.title) = ${word})`).execute();
  return { names: [...new Set(rows.filter((r) => r.provides).map((r) => r.title))], otherTagNamed: rows.some((r) => !r.provides) };
}

/** 延伸（tag_schema.extends）了 `tagId` 的標籤，任何深度，不含自己：查詢這個標籤時也列它們的筆記。
 *  成員查詢的舊規則（過渡；標籤層放平後新增的延伸不會再有）。 */
export async function extenderTagIds(workspaceId: string, tagId: string): Promise<string[]> {
  return extendersIn(await loadExtendsGraph(workspaceId), tagId);
}

export type ExtendsRow = { id: string; extends: unknown };

/** 每個 live 標籤的 extends 清單（成員查詢與合併用的圖）。 */
export async function loadExtendsGraph(workspaceId: string): Promise<ExtendsRow[]> {
  return (await liveTags(workspaceId)).map(({ id, extends: list }) => ({ id, extends: list }));
}

function extendersIn(rows: ExtendsRow[], tagId: string): string[] {
  const children = new Map<string, string[]>();
  for (const row of rows) {
    for (const parent of extendsIdsOf(row.extends)) children.set(parent, [...(children.get(parent) ?? []), row.id]);
  }
  const found = new Set<string>();
  for (const queue = [tagId]; queue.length;) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (child !== tagId && !found.has(child)) { found.add(child); queue.push(child); }
    }
  }
  return [...found];
}

/** 給這個標籤這些 extends，會造成標籤（直接或間接）互相延伸嗎？ */
export function wouldCreateExtendsCycle(rows: ExtendsRow[], tagId: string, targets: string[]): boolean {
  const extenders = new Set(extendersIn(rows, tagId));
  return targets.some((target) => target === tagId || extenders.has(target));
}

/** 新建節點時一次給它的功能引用（標籤包匯入的標籤；任務節點的 'tasks'）：不另記事件，建立節點的事件已記下；
 *  設定來源是各功能的模組標籤（等於引用者自己時省略）。 */
export async function insertFunctionRefs(
  workspaceId: string, holderId: string, functions: Array<{ functionId: string; sourceTagId: string }>,
): Promise<void> {
  for (const { functionId, sourceTagId } of functions) {
    await q(
      `INSERT INTO function_refs (workspace_id, function_id, holder_node_id, config) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
      [workspaceId, functionId, holderId, JSON.stringify(sourceTagId === holderId ? {} : { source_tag_id: sourceTagId })],
    );
  }
}

// ── 模組標籤（還存在時）的讀法 ───────────────────────────────────────────────

/** 工作區裡標記為這個模組的標籤（live、最早建立者）：id、標題與存著的 behaviour（複習的每日上限還讀它）；沒有就 null。 */
export async function moduleTagInfo(workspaceId: string, moduleId: string): Promise<{ id: string; title: string; behaviour: Record<string, unknown> | null } | null> {
  const row = await db.selectFrom("content_nodes")
    .select(["id", "title", sql<Record<string, unknown> | null>`tag_schema->'behaviour'`.as("behaviour")])
    .where("workspace_id", "=", workspaceId).where("node_type", "=", TAG_NODE_TYPE).where("deleted_at", "is", null)
    .where(sql<boolean>`tag_schema->>'module' = ${moduleId}`).orderBy("created_at").orderBy("id").limit(1).executeTakeFirst();
  return row ? { id: row.id, title: row.title, behaviour: row.behaviour } : null;
}

/** 模組當保留字用的名字：標記為這個模組的 live 標籤現在的名稱（小寫），以及 `candidates` 之中被「普通標籤」佔走的（小寫）。 */
export async function moduleWordNames(workspaceId: string, moduleId: string, candidates: readonly string[]): Promise<{ marked: string[]; ordinary: string[] }> {
  const rows = await db.selectFrom("content_nodes")
    .select([sql<string>`lower(title)`.as("title"), sql<string | null>`tag_schema->>'module'`.as("module")])
    .where("workspace_id", "=", workspaceId).where("node_type", "=", TAG_NODE_TYPE).where("deleted_at", "is", null)
    .where(sql<boolean>`(tag_schema->>'module' = ${moduleId} OR lower(title) = ANY(${[...candidates]}::text[]))`).execute();
  return { marked: rows.filter((row) => row.module === moduleId).map((row) => row.title), ordinary: rows.filter((row) => row.module !== moduleId).map((row) => row.title) };
}

// ── 筆記或段落自己的引用（複習卡）────────────────────────────────────────────

/** 自己引用功能的筆記或段落。寫入由呼叫者的領域操作負責權限與事件（setNoteCard、段落存檔）。 */
export type OwnRefHolder = { kind: "node" | "block"; id: string };
const ownColumn = (holder: OwnRefHolder) => (holder.kind === "block" ? "holder_block_id" : "holder_node_id") as "holder_block_id" | "holder_node_id";

/** 這個筆記或段落自己的引用 id；沒有就 null。 */
export async function ownRefId(holder: OwnRefHolder, functionId: string): Promise<string | null> {
  return (await db.selectFrom("function_refs").select("id").where(ownColumn(holder), "=", holder.id)
    .where("function_id", "=", functionId).where("instance", "=", "").executeTakeFirst())?.id ?? null;
}

/** 讓筆記或段落自己引用一個功能（已經有就不動）。回傳新列的 id；本來就有則 null。要在交易內。
 *  `by` is the writer; created_by records carriedActorId(by) (null for a temporary session: spine/authority.ts). */
export async function insertOwnRef(
  workspaceId: string, holder: OwnRefHolder, functionId: string, { by = null, id = randomUUID(), config = {} }: { by?: ActorCtx | null; id?: string; config?: Record<string, unknown> } = {},
): Promise<string | null> {
  requireTransaction("insertOwnRef");
  return (await db.insertInto("function_refs")
    .values({ id, workspace_id: workspaceId, function_id: functionId, [ownColumn(holder)]: holder.id, config: JSON.stringify(config), created_by: by ? carriedActorId(by) : null })
    .onConflict((conflict) => conflict.doNothing()).returning("id").executeTakeFirst())?.id ?? null;
}

/** 筆記或段落自己的引用是怎麼來的，記在引用的 config.via：`word` ＝ 段落內文的功能字（`{review}`）讓它成為卡片。
 *  內文拿掉字時只拿掉這種引用；搬遷（195）從標籤轉來的、指令做成的（setNoteCard）不帶 via，不因編輯文字而消失。 */
export const OWN_REF_VIA_WORD = "word";

/** 這個引用是內文的字做的（之後字被拿掉就拿掉它）：沒有引用就補上，已有但不是這樣來的就記上。要在交易內。 */
export async function markOwnRefViaWord(workspaceId: string, holder: OwnRefHolder, functionId: string, { by = null }: { by?: ActorCtx | null } = {}): Promise<void> {
  requireTransaction("markOwnRefViaWord");
  await insertOwnRef(workspaceId, holder, functionId, { by, config: { via: OWN_REF_VIA_WORD } });
  await db.updateTable("function_refs").set({ config: sql`config || '{"via":"word"}'::jsonb`, updated_at: sql`now()` })
    .where(ownColumn(holder), "=", holder.id).where("function_id", "=", functionId).where("instance", "=", "")
    .where(sql<boolean>`NOT (config ? 'via')`).execute();
}

/** 拿掉內文的字做的引用（`markOwnRefViaWord`）；別的來源的引用不動。回傳是否拿掉。要在交易內。 */
export async function deleteOwnRefViaWord(holder: OwnRefHolder, functionId: string): Promise<boolean> {
  requireTransaction("deleteOwnRefViaWord");
  return (await db.deleteFrom("function_refs").where(ownColumn(holder), "=", holder.id).where("function_id", "=", functionId)
    .where("instance", "=", "").where(sql<boolean>`config->>'via' = ${OWN_REF_VIA_WORD}`).returning("id").executeTakeFirst()) !== undefined;
}

/** 拿掉筆記或段落自己的引用；回傳被刪那列的 id，本來就沒有則 null。要在交易內。 */
export async function deleteOwnRef(holder: OwnRefHolder, functionId: string): Promise<string | null> {
  requireTransaction("deleteOwnRef");
  return (await db.deleteFrom("function_refs").where(ownColumn(holder), "=", holder.id).where("function_id", "=", functionId)
    .where("instance", "=", "").returning("id").executeTakeFirst())?.id ?? null;
}

// ── 寫 ──────────────────────────────────────────────────────────────────────

type LockedTag = { id: string; title: string; tag_schema: Record<string, unknown> | null };

export async function lockTag(workspaceId: string, tagId: string): Promise<LockedTag | undefined> {
  return (await q<LockedTag>(
    `SELECT id::text, title, tag_schema FROM content_nodes
      WHERE workspace_id = $1 AND id = $2 AND ${liveTagNodeSql()} FOR UPDATE`,
    [workspaceId, tagId],
  )).rows[0];
}

/** 這個功能的模組標籤（live、標記 tag_schema.module＝功能 id、最早建立者）。 */
async function moduleTagOf(workspaceId: string, functionId: string): Promise<string | null> {
  return (await q<{ id: string }>(
    `SELECT id::text FROM content_nodes
      WHERE workspace_id = $1 AND ${liveTagNodeSql()} AND tag_schema->>'module' = $2
      ORDER BY created_at, id LIMIT 1`,
    [workspaceId, functionId],
  )).rows[0]?.id ?? null;
}

async function setExtendsLink(workspaceId: string, tagId: string, next: string[]): Promise<void> {
  await writeTagSchema(workspaceId, tagId, { merge: { extends: next } });
}

async function tagExtendsNow(tagId: string): Promise<string[]> {
  return extendsIdsOf((await q<{ e: unknown }>(`SELECT tag_schema->'extends' AS e FROM content_nodes WHERE id = $1`, [tagId])).rows[0]?.e);
}

async function touchTag(tagId: string): Promise<void> {
  // 同步的標籤目錄靠標籤列的更新時間與 target_type=tag 的事件帶出變化。
  await q(`UPDATE content_nodes SET updated_at = now() WHERE id = $1`, [tagId]);
}

function nodeHolder(holder: FunctionHolder): string {
  if (holder.kind === "space") throw new FunctionRefError(400, "functions on a space are not open yet");
  if (!isUuid(holder.id)) throw new FunctionRefError(404);
  return holder.id;
}

async function sourceIsLive(tagId: string): Promise<boolean> {
  return (await db.selectFrom("content_nodes").select("id").where("id", "=", tagId).where("node_type", "=", TAG_NODE_TYPE).where("deleted_at", "is", null).executeTakeFirst()) !== undefined;
}

/** 標籤上這個功能的引用 id，不論設定來源還在不在（來源被刪的引用 functionsOf 看不到，但要能拿掉）。看不到這個標籤回 null。 */
export async function ownFunctionRefId(actor: ActorCtx, tagId: string, functionId: string): Promise<string | null> {
  if (!(await canSeeTag(actor, tagId))) return null;
  return (await db.selectFrom("function_refs").select("id").where("holder_node_id", "=", tagId).where("function_id", "=", functionId).where("instance", "=", "").executeTakeFirst())?.id ?? null;
}

/** 讓標籤引用一個功能。已經有就什麼都不做（`added: false`）。
 *  Example: addFunction({ actor, workspaceId, holder: { kind: "node", id: tagId }, functionId: "review" })
 *  要 principal_admin（事件鎖後用當前 actor 重判）；標籤必須 live 且看得到；功能 id 必須已登錄、不是視角。
 *  若工作區有這個功能的模組標籤，設定來源指向它，並把它加進 tag_schema.extends（成員查詢用）。 */
export function addFunction(input: {
  actor: ActorCtx; workspaceId: string; holder: FunctionHolder; functionId: string; config?: Record<string, unknown>;
}): Promise<{ refId: string; added: boolean }> {
  const { workspaceId, functionId } = input;
  let tagId: string;
  try { tagId = nodeHolder(input.holder); } catch (error) { return Promise.reject(error); }
  if (!registered.has(functionId)) return Promise.reject(new FunctionRefError(400, `unknown tag function: ${functionId}`));
  if (isViewLayout(functionId)) return Promise.reject(new FunctionRefError(400, "a view is added as a tab, not as a function"));
  const config = input.config ?? {};
  if (Object.hasOwn(config, "source_tag_id")) return Promise.reject(new FunctionRefError(400, "source_tag_id is not a setting"));
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    await assertAuthority(actor, { kind: "principal_admin" });
    if (!(await canSeeTag(actor, tagId))) throw new FunctionRefError();
    const tag = await lockTag(workspaceId, tagId);
    if (!tag) throw new FunctionRefError();
    const existing = (await q<RefRow>(
      `SELECT id::text, function_id, instance, config, holder_node_id::text FROM function_refs WHERE holder_node_id = $1 AND function_id = $2 AND instance = ''`, [tagId, functionId],
    )).rows[0];
    if (existing) {
      // A reference whose module tag was deleted offers nothing (functionsOf hides it) and would also turn this add into "already there".
      // It is taken off through the ordinary removal (event, extends link), and the function added again from the module tag that exists now.
      if (await sourceIsLive(sourceOf(existing))) return { refId: existing.id, added: false };
      await removeFunction({ actor, workspaceId, refId: existing.id });
    }
    const module = await moduleTagOf(workspaceId, functionId);
    const source = module && module !== tagId ? module : null;
    const stored = source ? { ...config, source_tag_id: source } : config;
    const refId = randomUUID();
    const previousExtends = extendsIdsOf(tag.tag_schema?.extends);
    const link = !!source && !previousExtends.includes(source) && !wouldCreateExtendsCycle(await loadExtendsGraph(workspaceId), tagId, [source]);
    await mutate({
      actor, workspaceId, authority: { kind: "principal_admin" },
      event: {
        type: "FUNCTION_REF_ADDED", targetType: "tag", targetId: tagId,
        payload: { ref_id: refId, function_id: functionId, instance: "", config: stored, extends_linked: link ? source : null },
        txMeta: { inverse_op: "function_ref.removed", ui_context: "tag.function.add" },
      },
      apply: async () => {
        await q(
          `INSERT INTO function_refs (id, workspace_id, function_id, holder_node_id, config, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [refId, workspaceId, functionId, tagId, JSON.stringify(stored), carriedActorId(actor)],
        );
        // A label tag that gets a function becomes a class tag with a private schema (never published as a
        // collection), as the module switch always did; a merge into a missing schema would write nothing.
        if (!tag.tag_schema) await writeTagSchema(workspaceId, tagId, { replace: buildTagSchema({ name: tag.title, slug: `module-${tagId}`, publishCollection: false }) });
        if (link) await setExtendsLink(workspaceId, tagId, [...previousExtends, source!]);
        await touchTag(tagId);
      },
    });
    return { refId, added: true };
  });
}

/** 拿掉一個引用（功能本身的資料——複習排程、任務屬性——不動）。
 *  模組標籤自己提供的功能不能拿掉（400）。 */
export function removeFunction(input: { actor: ActorCtx; workspaceId: string; refId: string }): Promise<{ removed: boolean }> {
  const { workspaceId, refId } = input;
  if (!isUuid(refId)) return Promise.reject(new FunctionRefError(404, "function reference not found"));
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    await assertAuthority(actor, { kind: "principal_admin" });
    const ref = (await q<RefRow>(
      `SELECT r.id::text, r.function_id, r.instance, r.config, r.holder_node_id::text FROM function_refs r
        WHERE r.id = $1 AND r.workspace_id = $2 AND r.holder_node_id IS NOT NULL AND r.instance = '' FOR UPDATE`, [refId, workspaceId],
    )).rows[0];
    if (!ref || !(await canSeeTag(actor, ref.holder_node_id))) throw new FunctionRefError(404, "function reference not found");
    const tag = await lockTag(workspaceId, ref.holder_node_id);
    if (!tag) throw new FunctionRefError(404, "function reference not found");
    if (tag.tag_schema?.module === ref.function_id) throw new FunctionRefError(400, "a module tag always has its own function");
    const source = typeof ref.config.source_tag_id === "string" ? ref.config.source_tag_id : null;
    const previousExtends = extendsIdsOf(tag.tag_schema?.extends);
    // 只有這個引用在用這條 extends 時才一起拿掉。
    const stillUsed = source ? (await q(
      `SELECT 1 FROM function_refs WHERE holder_node_id = $1 AND id <> $2 AND config->>'source_tag_id' = $3 LIMIT 1`,
      [tag.id, refId, source],
    )).rowCount! > 0 : true;
    const unlink = !!source && previousExtends.includes(source) && !stillUsed;
    await mutate({
      actor, workspaceId, authority: { kind: "principal_admin" },
      event: {
        type: "FUNCTION_REF_REMOVED", targetType: "tag", targetId: tag.id,
        payload: { ref_id: refId, function_id: ref.function_id, instance: ref.instance, config: ref.config, extends_unlinked: unlink ? source : null },
        txMeta: { inverse_op: "function_ref.added", ui_context: "tag.function.remove" },
      },
      apply: async () => {
        await q(`DELETE FROM function_refs WHERE id = $1`, [refId]);
        if (unlink) await setExtendsLink(workspaceId, tag.id, previousExtends.filter((id) => id !== source));
        await touchTag(tag.id);
      },
    });
    return { removed: true };
  });
}

/** 改一個引用的設定（整份取代；設定來源 source_tag_id 由系統維護，保留）。沒有差別就不寫。 */
export function setFunctionConfig(input: {
  actor: ActorCtx; workspaceId: string; refId: string; config: Record<string, unknown>;
}): Promise<{ config: Record<string, unknown> }> {
  const { workspaceId, refId } = input;
  if (!isUuid(refId)) return Promise.reject(new FunctionRefError(404, "function reference not found"));
  if (Object.hasOwn(input.config, "source_tag_id")) return Promise.reject(new FunctionRefError(400, "source_tag_id is not a setting"));
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    await assertAuthority(actor, { kind: "principal_admin" });
    const ref = (await q<RefRow>(
      `SELECT id::text, function_id, instance, config, holder_node_id::text FROM function_refs
        WHERE id = $1 AND workspace_id = $2 AND holder_node_id IS NOT NULL AND instance = '' FOR UPDATE`, [refId, workspaceId],
    )).rows[0];
    if (!ref || !(await canSeeTag(actor, ref.holder_node_id)) || !(await lockTag(workspaceId, ref.holder_node_id))) {
      throw new FunctionRefError(404, "function reference not found");
    }
    const next = typeof ref.config.source_tag_id === "string" ? { ...input.config, source_tag_id: ref.config.source_tag_id } : input.config;
    if (isDeepStrictEqual(next, ref.config)) return { config: ref.config };
    await mutate({
      actor, workspaceId, authority: { kind: "principal_admin" },
      event: {
        type: "FUNCTION_REF_CONFIG_CHANGED", targetType: "tag", targetId: ref.holder_node_id,
        payload: { ref_id: refId, function_id: ref.function_id, config: next },
        txMeta: { inverse_op: "function_ref.config_changed", prev_field_values: { config: ref.config }, ui_context: "tag.function.config" },
      },
      apply: async () => {
        await q(`UPDATE function_refs SET config = $2::jsonb, updated_at = now() WHERE id = $1`, [refId, JSON.stringify(next)]);
        await touchTag(ref.holder_node_id);
      },
    });
    return { config: next };
  });
}

// ── 已存檢視（B2）──────────────────────────────────────────────────────────
// 標籤與筆記的已存檢視是同一種引用（instance＝檢視 id）。這一段只管儲存；誰能寫、事件、路由形狀在
// tagViews.ts／noteViews.ts。呼叫者已在事件交易內鎖住引用者的列（FOR UPDATE），所以「查名字再寫」不會被插隊。

/** 檢視在線上傳輸的形狀（與搬遷前 collection_views 陣列的元素相同）：標籤的帶 tag_id，其他節點帶 node_id。 */
export type ViewRecord = Record<string, unknown> & { id: string; layout: string };

/** 'list' 版面已移除，讀成 'table'（遷移 111 轉過存放的資料；舊客戶端、舊事件仍可能說 'list'）。 */
const normalizedLayout = (layout: string): string => layout === "list" ? "table" : layout;

type ViewRefRow = { instance: string; function_id: string; config: Record<string, unknown> };

function viewRecordOf(kind: "tag" | "note", holderId: string, row: ViewRefRow): ViewRecord {
  return { ...row.config, id: row.instance, layout: row.function_id, [kind === "tag" ? "tag_id" : "node_id"]: holderId };
}

/** 一個節點的全部檢視（建立順序）。 */
export async function viewRecordsOf(kind: "tag" | "note", workspaceId: string, holderId: string): Promise<ViewRecord[]> {
  return (await viewRecordsOfMany(kind, workspaceId, [holderId])).get(holderId) ?? [];
}

/** 多個節點的檢視，依節點 id 分組（標籤頁的繼承檢視一次讀完）。 */
export async function viewRecordsOfMany(kind: "tag" | "note", workspaceId: string, holderIds: string[]): Promise<Map<string, ViewRecord[]>> {
  const out = new Map<string, ViewRecord[]>();
  if (holderIds.length === 0) return out;
  const rows = await db.selectFrom("function_refs").select(["holder_node_id", "instance", "function_id", "config"])
    .where("workspace_id", "=", workspaceId).where("holder_node_id", "in", holderIds).where("instance", "<>", "").orderBy("created_at").orderBy("id").execute();
  for (const row of rows) {
    const holderId = row.holder_node_id!;
    out.set(holderId, [...(out.get(holderId) ?? []), viewRecordOf(kind, holderId, row as ViewRefRow)]);
  }
  return out;
}

/** 一個檢視；不在這個節點上就是 null。 */
export async function viewRecordById(kind: "tag" | "note", workspaceId: string, holderId: string, viewId: string): Promise<ViewRecord | null> {
  const row = await db.selectFrom("function_refs").select(["instance", "function_id", "config"])
    .where("workspace_id", "=", workspaceId).where("holder_node_id", "=", holderId).where("instance", "=", viewId).executeTakeFirst();
  return row ? viewRecordOf(kind, holderId, row as ViewRefRow) : null;
}

/** 這個名字已有別的檢視用了嗎（精確比對、照輸入）。`exceptViewId` 是正在改名的那一個。 */
export async function viewNameTaken(workspaceId: string, holderId: string, name: string, exceptViewId?: string): Promise<boolean> {
  let query = db.selectFrom("function_refs").select("id")
    .where("workspace_id", "=", workspaceId).where("holder_node_id", "=", holderId).where("instance", "<>", "").where(sql`config->>'name'`, "=", name)
    // The 「內容」 record's stored name is never shown (the tab is called by the person's language), so it takes no part in "taken".
    .where("function_id", "<>", CONTENT_LAYOUT);
  if (exceptViewId) query = query.where("instance", "<>", exceptViewId);
  return (await query.limit(1).executeTakeFirst()) !== undefined;
}

/** 這則筆記的「內容」分頁可以收起來嗎：還有別的分頁會顯示。這是唯一的答案：列出檢視時回給畫面（`content_tab_removable`），
 *  下面的保證也用它，畫面不自己再算一次。別的分頁＝沒收起來的其他檢視紀錄，或一塊有卡片卻還沒有白板紀錄的白板
 *  （畫面把它算成分頁），或已退役的白板種類；白板紀錄若收起來了就不算。紀錄還在但這台看不到的分頁（模組關著）算有：
 *  那種情況由畫面的保底算出來顯示「內容」。 */
export async function contentTabRemovable(workspaceId: string, holderId: string): Promise<boolean> {
  const found = await sql<{ yes: boolean }>`SELECT (
      EXISTS (SELECT 1 FROM function_refs fr
               WHERE fr.workspace_id = ${workspaceId} AND fr.holder_node_id = ${holderId} AND fr.instance <> '' AND fr.function_id <> ${CONTENT_LAYOUT}
                 AND COALESCE(fr.config->'layout_config'->>'hidden', '') <> 'true')
      OR (
        NOT EXISTS (SELECT 1 FROM function_refs wr
                     WHERE wr.workspace_id = ${workspaceId} AND wr.holder_node_id = ${holderId} AND wr.instance <> '' AND wr.function_id = ${WHITEBOARD_LAYOUT})
        AND (EXISTS (SELECT 1 FROM node_positions np WHERE np.workspace_id = ${workspaceId} AND np.surface = ${holderId}::text)
             OR EXISTS (SELECT 1 FROM content_nodes cn WHERE cn.workspace_id = ${workspaceId} AND cn.id = ${holderId} AND cn.node_type = 'canvas'))
      )) AS yes`.execute(db);
  return found.rows[0]?.yes === true;
}

/** 一則筆記沒有別的分頁可顯示時，它的「內容」分頁不是收起來的（收起來是「別的分頁在，這個先不看」）。
 *  寫檢視紀錄的三個函式（新增、改、刪）在同一筆交易的最後都過這裡：建立、複製、備份還原、別台或 MCP 刪掉最後一個分頁，
 *  都得到同一個保證，客戶端不必再補一個請求。 */
async function keepContentTabShowing(workspaceId: string, holderId: string): Promise<void> {
  const hidden = await db.selectFrom("function_refs").select("instance")
    .where("workspace_id", "=", workspaceId).where("holder_node_id", "=", holderId).where("function_id", "=", CONTENT_LAYOUT).where("instance", "<>", "")
    .where(sql`config->'layout_config'->>'hidden'`, "=", "true").limit(1).executeTakeFirst();
  if (!hidden) return;
  if (!(await contentTabRemovable(workspaceId, holderId))) await patchView(workspaceId, holderId, hidden.instance, { layout_config_patch: { hidden: null } });
}

/** 新增一個檢視（呼叫者已檢查名字與權限）。`element` 是檢視的內容（不含 id、版面）。 */
export async function insertView(input: {
  workspaceId: string; holderId: string; viewId: string; layout: string; element: Record<string, unknown>; by?: ActorCtx | null;
}): Promise<void> {
  requireTransaction("insertView");
  const { tag_id: _tag, node_id: _node, id: _id, layout: _layout, ...config } = input.element;
  await db.insertInto("function_refs").values({
    workspace_id: input.workspaceId, function_id: normalizedLayout(input.layout), instance: input.viewId,
    config: JSON.stringify(config), holder_node_id: input.holderId,
    created_by: input.by ? carriedActorId(input.by) : null,
  }).execute();
  await keepContentTabShowing(input.workspaceId, input.holderId);
}

/** 把改到的欄位併進檢視（版面變成 function_id，其餘併進 config）。回傳有沒有這個檢視。 */
export async function patchView(workspaceId: string, holderId: string, viewId: string, patch: Record<string, unknown>): Promise<boolean> {
  requireTransaction("patchView");
  const { layout, id: _id, tag_id: _tag, node_id: _node, layout_config_patch: layoutPatch, ...rest } = patch;
  let config = sql<JsonObject>`config || ${JSON.stringify(rest)}::jsonb`;
  if (layoutPatch && typeof layoutPatch === "object") {
    // Per key, inside the UPDATE itself: the row's current layout_config is the base, so a change made by
    // another device a moment ago is kept; `null` removes the key.
    const entries = Object.entries(layoutPatch as Record<string, unknown>);
    const set = Object.fromEntries(entries.filter(([, v]) => v !== null));
    const removed = entries.filter(([, v]) => v === null).map(([k]) => k);
    let merged = sql`(CASE WHEN jsonb_typeof(config->'layout_config') = 'object' THEN config->'layout_config' ELSE '{}'::jsonb END) || ${JSON.stringify(set)}::jsonb`;
    if (removed.length > 0) merged = sql`(${merged}) - ARRAY[${sql.join(removed)}]::text[]`;
    config = sql<JsonObject>`jsonb_set(${config}, '{layout_config}', ${merged})`;
  }
  const result = await db.updateTable("function_refs").set({
    config, updated_at: sql`now()`,
    ...(typeof layout === "string" ? { function_id: normalizedLayout(layout) } : {}),
  }).where("workspace_id", "=", workspaceId).where("holder_node_id", "=", holderId).where("instance", "=", viewId).executeTakeFirst();
  await keepContentTabShowing(workspaceId, holderId);
  return Number(result.numUpdatedRows) > 0;
}

export async function removeView(workspaceId: string, holderId: string, viewId: string): Promise<void> {
  requireTransaction("removeView");
  await db.deleteFrom("function_refs").where("workspace_id", "=", workspaceId).where("holder_node_id", "=", holderId).where("instance", "=", viewId).execute();
  await keepContentTabShowing(workspaceId, holderId);
}

/** 一列節點（`SELECT *`／`RETURNING *` 拿到的）換成客戶端存的樣子：`collection_views` 凍結了，改由引用組回。
 *  寫入的回應、事件的節點列都要經過這裡（或用 nodeRowColumnsSql），否則客戶端會用 NULL 蓋掉 store 裡的檢視。 */
export async function withViews<T extends { id: string; node_type: string }>(workspaceId: string, row: T): Promise<T & { collection_views: ViewRecord[] | null }> {
  const views = await viewRecordsOf(isTag(row) ? "tag" : "note", workspaceId, row.id);
  // sort_order is the integer order frozen by migration 200: nothing reads it, so it is not sent either.
  const { sort_order: _frozenSortOrder, ...sent } = row as T & { sort_order?: unknown };
  return { ...(sent as unknown as T), collection_views: views.length > 0 ? views : null };
}

/** 讓同步的標籤目錄看到變化（標籤列的更新時間；筆記的檢視事件指向筆記，由事件帶出）。 */
export const touchViewHolder = touchTag;

// ── 復原（restoreEvent 的註冊處理器）────────────────────────────────────────

type Inspection = { error: RestoreError } | { refusal?: RestoreError; ref: RefRow | undefined; payload: Record<string, unknown> };

const conflict = (detail: string): RestoreError => ({ code: "state_conflict", status: 409, detail, force_available: false });
const incomplete = (detail: string): RestoreError => ({ code: "history_incomplete", status: 409, detail, force_available: false });

async function inspect(row: EventRow, lock: boolean): Promise<Inspection> {
  const p = row.payload;
  const refId = p.ref_id;
  if (typeof refId !== "string" || !isUuid(refId) || typeof p.function_id !== "string") {
    return { error: incomplete("function reference event has no complete record") };
  }
  // The target is a tag, or a note that is a card itself (setNoteCard). A paragraph card's reference follows the paragraph's text and
  // writes no function event.
  const tag = (await q<{ id: string; node_type: string }>(
    `SELECT id::text, node_type FROM content_nodes WHERE id = $1 AND node_type IN ('class_tag', 'content') AND ${liveNodeSql()}`, [row.target_id],
  )).rows[0];
  if (!tag) return { error: { code: "target_gone", status: 410, detail: "the tag or note is gone" } };
  const isNote = tag.node_type === "content";
  const ref = (await q<RefRow>(
    `SELECT id::text, function_id, instance, config, holder_node_id::text FROM function_refs WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [refId],
  )).rows[0];
  const sameKey = ref ? undefined : (await q<{ id: string }>(
    `SELECT id::text FROM function_refs WHERE holder_node_id = $1 AND function_id = $2 AND instance = $3`,
    [row.target_id, p.function_id, typeof p.instance === "string" ? p.instance : ""],
  )).rows[0];
  const base = { ref, payload: p };
  const alreadyIn = (detail: string): RestoreError => ({ code: "already_in_state", status: 409, detail });
  switch (row.event_type) {
    case "FUNCTION_REF_ADDED":
      if (!ref) return { ...base, refusal: alreadyIn(isNote ? "this note is no longer a review card" : "this function is already removed") };
      if (!isDeepStrictEqual(ref.config, jsonObject(p.config))) {
        return { ...base, refusal: conflict("the function's settings changed after this event; its current settings were preserved") };
      }
      return base;
    case "FUNCTION_REF_REMOVED": {
      if (ref || sameKey) return { ...base, refusal: alreadyIn(isNote ? "this note is a review card again" : "this tag has the function again") };
      const source = jsonObject(p.config).source_tag_id;
      if (typeof source === "string" && !(await q(
        `SELECT 1 FROM content_nodes WHERE id = $1 AND ${liveTagNodeSql()}`, [source],
      )).rowCount) return { ...base, refusal: conflict("the tag this function's settings come from is gone") };
      return base;
    }
    default: { // FUNCTION_REF_CONFIG_CHANGED
      if (!ref) return { ...base, refusal: conflict("the function was removed after this event") };
      if (!isDeepStrictEqual(ref.config, jsonObject(p.config))) {
        return { ...base, refusal: conflict("the function's settings changed after this event; its current settings were preserved") };
      }
      if (!Object.hasOwn(jsonObject(row.tx_meta.prev_field_values), "config")) return { ...base, refusal: incomplete("function reference event has no previous settings") };
      return base;
    }
  }
}

async function restoreFunctionRef(row: EventRow, context: RestoreContext): Promise<RestoreResult | RestoreError> {
  const inspected = await inspect(row, true);
  if ("error" in inspected) return inspected.error;
  if (inspected.refusal) return inspected.refusal;
  const { ref, payload: p } = inspected;
  const workspaceId = row.workspace_id;
  const tagId = row.target_id;
  const functionId = String(p.function_id);
  const refId = String(p.ref_id);
  if (row.event_type === "FUNCTION_REF_ADDED") {
    const link = typeof p.extends_linked === "string" ? p.extends_linked : null;
    await q(`DELETE FROM function_refs WHERE id = $1`, [refId]);
    if (link) {
      const current = await tagExtendsNow(tagId);
      if (current.includes(link)) await setExtendsLink(workspaceId, tagId, current.filter((id) => id !== link));
    }
    await touchTag(tagId);
    return context.record({
      eventType: "FUNCTION_REF_REMOVED",
      payload: { ref_id: refId, function_id: functionId, instance: p.instance ?? "", config: p.config, extends_unlinked: link },
      inverseOp: "function_ref.added", previous: null,
    });
  }
  if (row.event_type === "FUNCTION_REF_REMOVED") {
    const unlinked = typeof p.extends_unlinked === "string" ? p.extends_unlinked : null;
    await q(
      `INSERT INTO function_refs (id, workspace_id, function_id, instance, holder_node_id, config) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [refId, workspaceId, functionId, typeof p.instance === "string" ? p.instance : "", tagId, JSON.stringify(jsonObject(p.config))],
    );
    if (unlinked) {
      const current = await tagExtendsNow(tagId);
      if (!current.includes(unlinked)) await setExtendsLink(workspaceId, tagId, [...current, unlinked]);
    }
    await touchTag(tagId);
    return context.record({
      eventType: "FUNCTION_REF_ADDED",
      payload: { ref_id: refId, function_id: functionId, instance: p.instance ?? "", config: p.config, extends_linked: unlinked },
      inverseOp: "function_ref.removed", previous: null,
    });
  }
  const previous = jsonObject(jsonObject(row.tx_meta.prev_field_values).config);
  await q(`UPDATE function_refs SET config = $2::jsonb, updated_at = now() WHERE id = $1`, [refId, JSON.stringify(previous)]);
  await touchTag(tagId);
  return context.record({
    eventType: "FUNCTION_REF_CONFIG_CHANGED",
    payload: { ref_id: refId, function_id: functionId, config: previous },
    inverseOp: "function_ref.config_changed", previous: { config: ref!.config },
  });
}

async function previewFunctionRef(row: EventRow) {
  const inspected = await inspect(row, false);
  if ("error" in inspected) return inspected.error;
  return {
    kind: row.event_type === "FUNCTION_REF_ADDED" ? "function_remove" : row.event_type === "FUNCTION_REF_REMOVED" ? "function_add" : "function_config",
    function_id: String(inspected.payload.function_id),
    can_apply_cleanly: !inspected.refusal,
    force_available: false as const,
    ...(inspected.refusal ? { reason: inspected.refusal.detail, conflict_code: inspected.refusal.code } : {}),
  };
}

export const FUNCTION_REF_EVENT_TYPES = ["FUNCTION_REF_ADDED", "FUNCTION_REF_REMOVED", "FUNCTION_REF_CONFIG_CHANGED"] as const;

registerRestoreHandler({ eventTypes: FUNCTION_REF_EVENT_TYPES, restore: restoreFunctionRef, preview: previewFunctionRef });
