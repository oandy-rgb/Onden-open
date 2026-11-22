// 資料被還原之後，這台換一個新的節點編號（伺服器那邊是 scripts/restore.sh；規則與 SQL 是同一份：scripts/lib/renewNodeId.sql）。
// 不依賴 Electron：後端子程序的入口 serverEntry.mjs 在載入後端（也就是 migration）之前呼叫 renewBeforeBoot。
//
// 為什麼：每一筆修改都記著「哪個節點編號、第幾號」。還原把資料庫倒回備份那一刻，連同當時的編號與號碼；這台在備份之後又往下編過號，
// 沿用舊編號就會把同一組（編號，號碼）再發給另一筆內容不同的修改。所以還原之後、任何寫入之前，換一個新編號，舊編號記成「這台以前的編號」
// （sync_origins 'self-restore'，快照把它當成 former 帶出去：migration 213／214）。
//
// 兩種還原、兩種認法：
//   1. Onden 自己做的還原（safeUpdate.mjs restoreBackup：選單手動還原、升級失敗退回、補完中斷的更新）：還原一開始就寫 renew-node-id.json（markRenewalPending），
//      下次開後端一定換號。標記在還原「之前」寫：還原被打斷、或使用者選「直接開啟現有資料」放棄還原，照樣換號（多換一次只是多一個舊編號，無害）。
//   2. 使用者關掉 Onden、自己把舊的資料夾放回去（docs/desktop/README.md「怎麼備份」）：沒有任何程式知道。認法是資料夾外面的
//      <userData>.node-record.json：每次開後端（換號之後）與乾淨關閉時，記下這台的節點編號與每個工作區編到第幾號。
//      開後端時資料庫的編號與紀錄相同、但某個工作區的號碼比紀錄小＝資料倒回去了 → 換號。
//      **認不出來的**：(a) 紀錄寫下之後才複製的資料夾，又在沒有乾淨關閉（當掉、被強制結束）的情況下放回去：紀錄還停在開機那一刻；
//      (b) 連 <userData>.node-record.json 一起放回去、或把它刪掉；(c) 這個版本第一次開之前就放回去的資料夾（還沒有紀錄）；
//      (d) 把資料夾複製到另一台電腦、兩台都繼續用（兩份都沒有倒回去，是分家，這裡看不到另一台）。號碼一樣大時不換：沒有任何號碼被發兩次。
// 換號做不到時（備份來自 migration 190–205 的版本，沒有記舊編號的表；或備份沒有編號、但紀錄說這台有過編號）不開後端：
// 丟錯，啟動失敗，資料不動（換號本身是一個陳述式、一個交易）；不還原、不重試（safeUpdate.mjs renewal_refused）。
// 使用者選「照樣開啟」（keepNodeIdOnNextStart）才保留原本的編號，並記在資料庫的 sync_restore_kept_node_id：之後的裝置同步要擋（同伺服器的 --keep-node-id）。
import { existsSync, readFileSync, rmSync } from "node:fs";
import { RENEWAL_REFUSED_LOG_MARKER, writeFileDurable } from "./safeUpdate.mjs";

const NODE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @typedef {{ nodeId: string | null, clocks: Record<string, number> }} NodeState 這台的節點編號（還沒有＝null）與每個工作區的下一個號碼。 */
/** @typedef {(text: string, params?: unknown[]) => Promise<{ rows: any[] }>} Query */

/** 資料庫現在的節點編號與號碼；沒有那些表（很舊的版本、全新的資料庫）就是沒有。 @param {Query} query @returns {Promise<NodeState>} */
export async function readNodeState(query) {
  const has = async (/** @type {string} */ table) => (await query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table])).rows[0]?.ok === true;
  const nodeId = (await has("sync_node")) ? ((await query(`SELECT node_id FROM sync_node WHERE singleton`)).rows[0]?.node_id ?? null) : null;
  /** @type {Record<string, number>} */
  const clocks = {};
  if (await has("sync_clock")) for (const r of (await query(`SELECT workspace_id::text AS ws, next_seq::text AS next FROM sync_clock`)).rows) clocks[r.ws] = Number(r.next);
  return { nodeId, clocks };
}

/** 資料夾外面的紀錄；沒有＝null。內容壞了也當成沒有（認不出倒回去，見檔頭 (b)），不擋開機。 @param {import("./dataLayout.mjs").DataLayout} layout @returns {NodeState | null} */
export function readNodeRecord(layout) {
  try {
    const parsed = JSON.parse(readFileSync(layout.nodeRecord, "utf8"));
    // a record that does not hold a node id is as good as none (it would only make the renewal refuse a "bad-node-id")
    if (parsed?.nodeId !== null && !(typeof parsed?.nodeId === "string" && NODE_ID.test(parsed.nodeId))) return null;
    const clocks = Object.fromEntries(Object.entries(parsed?.clocks ?? {}).filter(([, n]) => Number.isSafeInteger(n)));
    return { nodeId: parsed.nodeId, clocks: /** @type {Record<string, number>} */ (clocks) };
  } catch {
    return null;
  }
}

/** @param {import("./dataLayout.mjs").DataLayout} layout @param {NodeState} state */
export function writeNodeRecord(layout, state) {
  writeFileDurable(layout.nodeRecord, JSON.stringify(state, null, 2));
}

/** 資料庫是不是比紀錄舊：同一個編號、兩邊都有的某個工作區號碼變小。紀錄裡有、資料庫沒有的工作區不算：刪掉一個工作區不是倒回去
 *  （review of #1937, point 7；每換一次號就多一個舊編號，不白換）。 @param {NodeState | null} record @param {NodeState} now */
export function wentBack(record, now) {
  if (!record?.nodeId || record.nodeId !== now.nodeId) return false;
  return Object.entries(record.clocks).some(([ws, next]) => ws in now.clocks && now.clocks[ws] < next);
}

/** 使用者在「換不了號」時選了照樣開啟：下次開後端時換得了就換，換不了就保留原本的編號，並記在資料庫裡（renewNodeId.sql 'kept'）。
 *  @param {import("./dataLayout.mjs").DataLayout} layout */
export function keepNodeIdOnNextStart(layout) {
  writeFileDurable(layout.renewalMarker, JSON.stringify({ keep: true }, null, 2));
}
/** @param {import("./dataLayout.mjs").DataLayout} layout */
function keepRequested(layout) {
  try { return JSON.parse(readFileSync(layout.renewalMarker, "utf8"))?.keep === true; } catch { return false; }
}

/** 換號做不到（見檔頭）。訊息給診斷資訊用；畫面上的文字由 main.mjs 的啟動失敗對話框決定。 */
export class RenewalRefused extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`${RENEWAL_REFUSED_LOG_MARKER}: the restored data cannot take a new node id (${reason}); the backend was not started and nothing was changed`);
    this.name = "RenewalRefused";
    this.reason = reason;
  }
}

/**
 * 開後端（migration）之前：該換號就換，然後記下現況、清掉標記。
 * @param {{ layout: import("./dataLayout.mjs").DataLayout, query: Query, renewalSql: string }} options
 * @returns {Promise<{ renewed: false } | { renewed: true, why: "restored" | "went_back", before: string | null, after: string | null, kept: boolean }>}
 */
export async function renewBeforeBoot({ layout, query, renewalSql }) {
  const record = readNodeRecord(layout);
  const now = await readNodeState(query);
  const why = existsSync(layout.renewalMarker) ? "restored" : wentBack(record, now) ? "went_back" : null;
  if (!why) {
    writeNodeRecord(layout, now);
    return { renewed: false };
  }
  let outcome;
  try {
    await query(renewalSql);
    outcome = (await query(`SELECT * FROM pg_temp.onden_renew_after_restore($1, $2)`, [record?.nodeId ?? null, keepRequested(layout)])).rows[0];
  } catch (error) {
    const refused = /onden-restore: ([a-z-]+)/.exec(error instanceof Error ? error.message : String(error));
    if (refused) throw new RenewalRefused(refused[1]);
    throw error;
  } finally {
    await query(`DROP FUNCTION IF EXISTS pg_temp.onden_renew_after_restore(text, boolean)`).catch(() => undefined);
  }
  // 紀錄先於清標記：兩步之間被關掉，下次只會再換一次號（無害），不會沒換
  writeNodeRecord(layout, await readNodeState(query));
  rmSync(layout.renewalMarker, { force: true });
  return { renewed: true, why, before: outcome?.before_id ?? null, after: outcome?.after_id ?? null, kept: outcome?.outcome === "kept" };
}

/** 乾淨關閉時記下現況（serverEntry.mjs）：之後放回去的、在這之前複製的資料夾才認得出來。 @param {import("./dataLayout.mjs").DataLayout} layout @param {Query} query */
export async function recordNodeState(layout, query) {
  writeNodeRecord(layout, await readNodeState(query));
}
