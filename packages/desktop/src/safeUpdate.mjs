// 換版安全網：換版時先備份、升級失敗就把資料還原成備份、資料比程式新就不動它。
// 不依賴 Electron（普通 Node 就能跑，test/safeUpdate.test.mjs 直接測）；後端怎麼啟動由呼叫者傳入。
//
// 備份取捨：
//   • pgdata、設定、金鑰、筆記備份 git 全部複製（升級只會改資料庫，其他當保險一起帶）；
//   • 上傳檔 data/content/media 用「硬連結」：不佔第二份空間，也是最大的一塊。上傳檔只新增不原地改寫，
//     所以連結等於備份了當時的內容；代價是備份與現況共用檔案（刪掉現況的檔案不影響備份，備份資料夾仍留著一份）。
//     不同磁碟分割（無法硬連結）時退回複製。
//   • data/content 底下的快取與暫存（backup-uploads、backup-scratch、site-bundles）不備份：丟掉只是重建，
//     不排除的話舊的備份壓縮檔會讓每份備份越變越大。
//   • 空間不足：備份一份、還原時還要在旁邊再放一份才對調，所以要有「要複製的大小」的 2 倍（含 10% 餘裕）
//     才升級，否則不升級也不動資料。
//
// 中斷安全：備份之後、升級之前先寫「更新進行中」標記（update-in-progress.json，指向那份備份）。
// 升級成功（版本檔已換新）或還原整個做完才清掉。下次啟動先看標記：有就先把還原做完（還原可重複執行，
// 每次都收斂到備份的樣子），再做別的；所以升級或還原被強制結束、斷電，資料都不會停在半套。
import {
  closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  openSync, renameSync, rmSync, statfsSync, symlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** 每份備份帶走哪些東西（相對於資料夾根目錄）。linkSubdir：這個子資料夾用硬連結；skip：頂層不帶的快取。 @type {{ rel: string, linkSubdir?: string, skip?: string[] }[]} */
const BACKUP_ITEMS = [
  { rel: "pgdata" },
  { rel: join("data", "content"), linkSubdir: "media", skip: ["backup-uploads", "backup-scratch", "site-bundles"] },
  { rel: "secrets.json" },
  { rel: "desktop.json" },
  { rel: "version.json" },
];
const SPACE_MARGIN = 1.1;
const SPACE_FLOOR = 64 * 1024 * 1024;
/** 備份一份＋還原時暫放一份。 */
const COPIES_NEEDED = 2;
export const DEFAULT_KEEP = 3;
/** server.ts 在「資料庫比程式新」時記進後端日誌的固定字樣；測試會核對兩邊一致。 */
export const NEWER_DATA_LOG_MARKER = "資料庫比這個版本新";
/** serverEntry.mjs 在「還原後的資料換不了節點編號」時記進後端日誌的固定字樣（nodeRenewal.mjs RenewalRefused）。 */
export const RENEWAL_REFUSED_LOG_MARKER = "還原後的資料換不了節點編號";

/** 備份空間不夠；不會動到任何資料。 */
export class InsufficientSpaceError extends Error {
  /** @param {number} neededBytes @param {number} freeBytes */
  constructor(neededBytes, freeBytes) {
    super(`backup needs ${neededBytes} bytes, ${freeBytes} free`);
    this.name = "InsufficientSpaceError";
    this.neededBytes = neededBytes;
    this.freeBytes = freeBytes;
  }
}

/**
 * 啟動失敗後呼叫者要告訴使用者什麼。kind：
 *   data_newer 資料比程式新（資料沒動）；rolled_back 升級失敗、資料已還原；
 *   restore_failed 升級失敗而且還原也失敗（標記與備份都在，下次啟動會再試）；no_space 空間不足（沒升級、資料沒動）；
 *   backup_missing 上次更新沒做完、但標記指到的備份不見或不完整（無法還原；使用者可選擇放棄還原直接開啟）；
 *   renewal_refused 還原後的資料換不了節點編號（nodeRenewal.mjs；資料沒動、不還原、不再備份；使用者可選擇照樣開啟＝保留原本的編號）。
 */
export class UpdateFailure extends Error {
  /** @param {"data_newer" | "rolled_back" | "restore_failed" | "no_space" | "backup_missing" | "renewal_refused"} kind @param {{ from: string, to: string, cause?: unknown, diagnostics: string, backupDir?: string, neededBytes?: number, freeBytes?: number }} detail */
  constructor(kind, detail) {
    super(kind);
    this.name = "UpdateFailure";
    this.kind = kind;
    this.from = detail.from;
    this.to = detail.to;
    this.diagnostics = detail.diagnostics;
    this.backupDir = detail.backupDir;
    this.neededBytes = detail.neededBytes;
    this.freeBytes = detail.freeBytes;
    this.cause = detail.cause;
  }
}

// ── 版本檔 ───────────────────────────────────────────────────────────────────

/** @typedef {{ version: string, buildId: string, schema?: string }} BuildStamp schema：這個建置帶的最新一個資料庫升級檔名（拿來不開資料庫就判斷「資料比程式新」）。 */
/** 測試用：在每個可能被中斷的步驟前呼叫，丟錯就等於那一刻行程被砍。 @typedef {(name: string) => void} StepHook */

/** 版本檔上的名字：同一版本的不同建置也算不同（VPS 每部署一次就跟著換）。 @param {BuildStamp} stamp */
export function stampLabel(stamp) {
  return stamp.buildId ? `${stamp.version}+${stamp.buildId}` : stamp.version;
}

/** @param {import("./dataLayout.mjs").DataLayout} layout @returns {BuildStamp | null} */
export function readVersionStamp(layout) {
  try {
    const parsed = JSON.parse(readFileSync(layout.versionFile, "utf8"));
    if (typeof parsed?.version !== "string") return null;
    return { version: parsed.version, buildId: typeof parsed.buildId === "string" ? parsed.buildId : "", ...(typeof parsed.schema === "string" ? { schema: parsed.schema } : {}) };
  } catch {
    return null;
  }
}

/** @param {import("./dataLayout.mjs").DataLayout} layout @param {BuildStamp} stamp */
export function writeVersionStamp(layout, stamp) {
  writeFileDurable(layout.versionFile, JSON.stringify(stamp, null, 2));
}

/** 資料庫資料夾裡有東西＝這份資料以前開過。 @param {import("./dataLayout.mjs").DataLayout} layout */
function hasExistingData(layout) {
  try {
    return readdirSync(layout.pgdata).length > 0;
  } catch {
    return false;
  }
}

// ── 複製與大小 ───────────────────────────────────────────────────────────────

/** 遞迴複製；linkSubdir 底下的一般檔案用硬連結（失敗退回複製）；skip：頂層不帶的名稱；step：每個檔案前呼叫。 @param {string} src @param {string} dest @param {{ linkSubdir?: string, linking?: boolean, skip?: string[], step?: StepHook, durable?: boolean }} [opts] */
function copyTree(src, dest, opts = {}) {
  const stat = lstatSync(src);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(src), dest);
  } else if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true, mode: stat.mode & 0o777 });
    for (const entry of readdirSync(src)) {
      if (opts.skip?.includes(entry)) continue;
      const linking = opts.linking || (opts.linkSubdir !== undefined && entry === opts.linkSubdir);
      copyTree(join(src, entry), join(dest, entry), { linking, linkSubdir: opts.linkSubdir, step: opts.step, durable: opts.durable });
    }
    if (opts.durable) fsyncPath(dest);
  } else {
    opts.step?.("copy-file");
    if (opts.linking) {
      try { linkSync(src, dest); } catch { copyFileSync(src, dest); }
    } else {
      copyFileSync(src, dest);
      if (opts.durable) fsyncPath(dest);
    }
  }
}

/** 路徑底下所有檔案的大小總和；跳過頂層的 skipNames。 @param {string} path @param {string[]} [skipNames] */
function treeBytes(path, skipNames) {
  let stat;
  try { stat = lstatSync(path); } catch { return 0; }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path)) {
    if (skipNames?.includes(entry)) continue;
    total += treeBytes(join(path, entry));
  }
  return total;
}

/** @param {string} dir */
function freeBytesOf(dir) {
  const fs = statfsSync(dir);
  return Number(fs.bavail) * Number(fs.bsize);
}

/** @param {string} path */
function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

/** 把檔案或資料夾刷到磁碟（斷電後不會留下空的或被截斷的內容）；做不到（例如 Windows 不能開資料夾）就略過。 @param {string} path */
function fsyncPath(path) {
  try {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* 這個平台刷不了：已知限制，見 docs/desktop/README.md */ }
}

/** 寫暫存檔、刷到磁碟、改名、再刷資料夾：斷電後不是舊的完整內容、就是新的完整內容。 @param {string} file @param {string} text */
export function writeFileDurable(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  fsyncPath(dirname(file));
}

// ── 備份 ─────────────────────────────────────────────────────────────────────

/** @typedef {{ name: string, dir: string, kind: "update" | "restore", from: string, to: string, createdAt: string }} BackupInfo */

/** @param {string} label */
const safeLabel = (label) => label.replace(/[^A-Za-z0-9._+-]/g, "_");
/** @param {Date} date */
const timeStamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** 要複製的大小（不含硬連結的上傳檔與快取）。 @param {import("./dataLayout.mjs").DataLayout} layout */
export function backupSpaceNeeded(layout) {
  return BACKUP_ITEMS.reduce((sum, item) => sum + treeBytes(join(layout.root, item.rel), [...(item.linkSubdir ? [item.linkSubdir] : []), ...(item.skip ?? [])]), 0);
}

/** 備份（與之後可能的還原）需要的可用空間。 @param {number} needed */
export function requiredFreeBytes(needed) {
  return needed * COPIES_NEEDED * SPACE_MARGIN + SPACE_FLOOR;
}

/**
 * 備份目前的資料到 backups/before-<舊>-to-<新>-<時間>/。空間不夠丟 InsufficientSpaceError（什麼都沒建）。
 * 先建 .partial 再改名，中途失敗不會留下看起來完整的半份備份。
 * @param {import("./dataLayout.mjs").DataLayout} layout
 * @param {{ kind: "update" | "restore", from: string, to: string, now?: Date, freeBytes?: number, step?: StepHook }} options
 * @returns {BackupInfo}
 */
export function createBackup(layout, { kind, from, to, now = new Date(), freeBytes, step }) {
  mkdirSync(layout.backups, { recursive: true, mode: 0o700 });
  const needed = backupSpaceNeeded(layout);
  const free = freeBytes ?? freeBytesOf(layout.backups);
  if (free < requiredFreeBytes(needed)) throw new InsufficientSpaceError(needed, free);

  const baseName = `${kind === "restore" ? "before-restore" : "before"}-${safeLabel(from)}-to-${safeLabel(to)}-${timeStamp(now)}`;
  // 同一秒內重複啟動（失敗後馬上再開）：不覆蓋、不撞名。
  let name = baseName;
  for (let n = 2; existsSync(join(layout.backups, name)); n++) name = `${baseName}-${n}`;
  const dir = join(layout.backups, name);
  const partial = `${dir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { mode: 0o700 });
  try {
    const items = [];
    for (const item of BACKUP_ITEMS) {
      const source = join(layout.root, item.rel);
      if (!existsSync(source)) continue;
      const target = join(partial, item.rel);
      ensureParent(target);
      copyTree(source, target, { linkSubdir: item.linkSubdir, skip: item.skip, step, durable: true });
      items.push(item.rel);
    }
    writeFileDurable(join(partial, "meta.json"), JSON.stringify({ kind, from, to, createdAt: now.toISOString(), items }, null, 2));
    fsyncPath(partial);
    renameSync(partial, dir);
    fsyncPath(layout.backups);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    // 複製到一半磁碟滿了：當成空間不足，而不是「不明錯誤」。
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOSPC") throw new InsufficientSpaceError(needed, 0);
    throw error;
  }
  return { name, dir, kind, from, to, createdAt: now.toISOString() };
}

/** 全部完整的備份，新的在前。 @param {import("./dataLayout.mjs").DataLayout} layout @returns {BackupInfo[]} */
export function listBackups(layout) {
  /** @type {string[]} */
  let names = [];
  try { names = readdirSync(layout.backups); } catch { return []; }
  /** @type {BackupInfo[]} */
  const found = [];
  for (const name of names) {
    if (name.endsWith(".partial")) continue;
    try {
      const meta = JSON.parse(readFileSync(join(layout.backups, name, "meta.json"), "utf8"));
      if (typeof meta.createdAt !== "string") continue;
      found.push({ name, dir: join(layout.backups, name), kind: meta.kind === "restore" ? "restore" : "update", from: String(meta.from), to: String(meta.to), createdAt: meta.createdAt });
    } catch { /* 不是完整的備份資料夾，不列 */ }
  }
  return found.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.name.localeCompare(a.name)));
}

/** 每種（換版／還原前）各留最近 keep 份，其餘與殘留的 .partial 刪掉。 @param {import("./dataLayout.mjs").DataLayout} layout @param {number} [keep] */
export function pruneBackups(layout, keep = DEFAULT_KEEP) {
  try {
    for (const name of readdirSync(layout.backups)) {
      if (name.endsWith(".partial")) rmSync(join(layout.backups, name), { recursive: true, force: true });
    }
  } catch { return; }
  // 標記指到的備份是「還沒做完的還原」要用的資料：永遠不清。
  const pinned = readMarkerSafe(layout)?.backup;
  for (const kind of /** @type {const} */ (["update", "restore"])) {
    for (const old of listBackups(layout).filter((b) => b.kind === kind && b.name !== pinned).slice(Math.max(0, keep))) {
      rmSync(old.dir, { recursive: true, force: true });
    }
  }
}

// ── 還原 ─────────────────────────────────────────────────────────────────────

/** @typedef {{ kind: "upgrade" | "restore", backup: string, to: string }} UpdateMarker 更新進行中：資料要回到 backup 這份備份；to＝升級的目標版本標籤（還原則是還原後的版本）。 */

/** 標記檔內容不是有效的標記（空的、被截斷）：不知道該還原哪一份，不猜。 */
export class MarkerCorruptError extends Error {
  constructor() {
    super("update marker is unreadable");
    this.name = "MarkerCorruptError";
  }
}

/** @param {import("./dataLayout.mjs").DataLayout} layout @param {UpdateMarker} marker */
export function writeUpdateMarker(layout, marker) {
  writeFileDurable(layout.updateMarker, JSON.stringify(marker, null, 2));
}

/** 沒有標記回 null；標記壞掉就丟錯（不猜：猜錯可能把好資料蓋掉）。 @param {import("./dataLayout.mjs").DataLayout} layout @returns {UpdateMarker | null} */
export function readUpdateMarker(layout) {
  let raw;
  try { raw = readFileSync(layout.updateMarker, "utf8"); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return null;
    throw error;
  }
  /** @type {any} */
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new MarkerCorruptError(); }
  if (typeof parsed?.backup !== "string" || (parsed.kind !== "upgrade" && parsed.kind !== "restore")) throw new MarkerCorruptError();
  return { kind: parsed.kind, backup: parsed.backup, to: String(parsed.to ?? "") };
}

/** @param {import("./dataLayout.mjs").DataLayout} layout */
function readMarkerSafe(layout) {
  try { return readUpdateMarker(layout); } catch { return null; }
}

/** @param {import("./dataLayout.mjs").DataLayout} layout */
export function clearUpdateMarker(layout) {
  rmSync(layout.updateMarker, { force: true });
  fsyncPath(layout.root);
}

/**
 * 把備份裡的內容換回來（後端必須已停止）。**可以重複執行、每次都收斂到備份的樣子**：被打斷（強制結束、斷電）
 * 後再跑一次就會補完，所以呼叫者在還原整個做完之前不能清掉更新標記。
 * 每個項目先複製到 .restoring，再與現況對調（現況先移到 .replaced），最後才刪 .replaced。
 * 備份裡沒有的項目（備份當時還不存在）會從現況移除。
 * @param {import("./dataLayout.mjs").DataLayout} layout @param {string} backupDir @param {{ step?: StepHook }} [options]
 */
export function restoreBackup(layout, backupDir, { step } = {}) {
  if (!existsSync(join(backupDir, "meta.json"))) throw new Error(`${backupDir} is not a complete backup`);
  // 還原後的資料要換節點編號（nodeRenewal.mjs）：在動任何東西之前寫，中途被打斷、之後放棄還原也照樣換。
  markRenewalPending(layout, backupDir);
  // 上一次被打斷留下的暫存：.restoring 可能是半份、.replaced 是升級到一半的資料，兩者都不是我們要的。
  for (const item of BACKUP_ITEMS) {
    const target = join(layout.root, item.rel);
    rmSync(`${target}.restoring`, { recursive: true, force: true });
    rmSync(`${target}.replaced`, { recursive: true, force: true });
  }
  const staged = [];
  for (const item of BACKUP_ITEMS) {
    const source = join(backupDir, item.rel);
    if (!existsSync(source)) continue;
    const target = join(layout.root, item.rel);
    ensureParent(target);
    copyTree(source, `${target}.restoring`, { linkSubdir: item.linkSubdir, step, durable: true });
    step?.(`staged:${item.rel}`);
    staged.push(item);
  }
  for (const item of BACKUP_ITEMS) {
    const target = join(layout.root, item.rel);
    const inBackup = staged.includes(item);
    if (!inBackup && !existsSync(target)) continue;
    step?.(`swap-start:${item.rel}`);
    if (existsSync(target)) renameSync(target, `${target}.replaced`);
    step?.(`swap-middle:${item.rel}`);
    if (inBackup) renameSync(`${target}.restoring`, target);
    fsyncPath(dirname(target));
    step?.(`swap-done:${item.rel}`);
  }
  for (const item of BACKUP_ITEMS) rmSync(`${join(layout.root, item.rel)}.replaced`, { recursive: true, force: true });
}

/**
 * 啟動時先處理上次沒做完的更新：標記在 → 把資料還原成標記指到的備份（可重複執行），再清標記。
 * 例外：升級其實已成功（版本檔已是目標版本，只差清標記就被關掉）→ 只清標記，不還原。
 * @param {import("./dataLayout.mjs").DataLayout} layout @param {{ step?: StepHook }} [options]
 * @returns {{ action: "restored" | "completed", marker: UpdateMarker } | null}
 */
export function resumeInterruptedUpdate(layout, { step } = {}) {
  const marker = readUpdateMarker(layout);
  if (!marker) return null;
  if (marker.kind === "upgrade") {
    const stamp = readVersionStamp(layout);
    if (stamp && stampLabel(stamp) === marker.to) {
      clearUpdateMarker(layout);
      return { action: "completed", marker };
    }
  }
  restoreBackup(layout, join(layout.backups, marker.backup), { step });
  clearUpdateMarker(layout);
  return { action: "restored", marker };
}

/** 標記指到的備份是否完整（有 meta.json＝備份當時整份複製完並改名）。 @param {import("./dataLayout.mjs").DataLayout} layout @param {UpdateMarker} marker */
const markerBackupComplete = (layout, marker) => existsSync(join(layout.backups, marker.backup, "meta.json"));

/**
 * 啟動的第一件事（讀金鑰、建資料夾都要在它之後，否則會拿到半套的金鑰檔）：補完上次沒做完的更新。
 * 失敗丟 UpdateFailure：restore_failed（標記留著，下次再試）或 backup_missing（備份不見，無法還原）。
 * @param {import("./dataLayout.mjs").DataLayout} layout @param {{ to?: string, step?: StepHook }} [options]
 */
export function recoverFromInterruptedUpdate(layout, { to = "?", step } = {}) {
  /** @type {UpdateMarker | null} */
  let marker = null;
  try {
    marker = readUpdateMarker(layout);
    const stamp = readVersionStamp(layout);
    const upgradeAlreadyDone = marker?.kind === "upgrade" && stamp !== null && stampLabel(stamp) === marker.to;
    if (marker && !upgradeAlreadyDone && !markerBackupComplete(layout, marker)) {
      throw new UpdateFailure("backup_missing", {
        from: "?", to, backupDir: join(layout.backups, marker.backup),
        diagnostics: diagnosticsText({ from: "?", to, reason: `update marker (${marker.kind}) points to a missing or incomplete backup: ${marker.backup}`, tail: [] }),
      });
    }
    return resumeInterruptedUpdate(layout, { step });
  } catch (error) {
    if (error instanceof UpdateFailure) throw error;
    if (error instanceof MarkerCorruptError) {
      throw new UpdateFailure("backup_missing", {
        from: "?", to, cause: error, backupDir: layout.root,
        diagnostics: diagnosticsText({ from: "?", to, reason: "update marker is empty or damaged; cannot tell which backup to restore", tail: [] }),
      });
    }
    // 標記留著：下次啟動會再試一次，資料都還在備份裡。
    throw new UpdateFailure("restore_failed", {
      from: "?", to, cause: error, backupDir: layout.backups,
      diagnostics: diagnosticsText({ from: "?", to, reason: `resuming an interrupted update failed: ${failureReason(error)}`, tail: [] }),
    });
  }
}

/**
 * 還原後下次開後端要先換節點編號（nodeRenewal.mjs renewBeforeBoot 讀它、換完才刪）。不在 BACKUP_ITEMS 裡：還原不會把它蓋掉。
 * @param {import("./dataLayout.mjs").DataLayout} layout @param {string} backupDir
 */
export function markRenewalPending(layout, backupDir) {
  writeFileDurable(layout.renewalMarker, JSON.stringify({ backup: backupDir }, null, 2));
}

/** 使用者明確選擇「放棄還原、直接開啟現有資料」：只清標記，不動資料。 @param {import("./dataLayout.mjs").DataLayout} layout */
export function abandonInterruptedUpdate(layout) {
  clearUpdateMarker(layout);
}

/**
 * 使用者手動還原：另存目前資料（按錯了還能還原回來）→ 寫標記 → 還原 → 清標記。後端必須已停止。
 * @param {import("./dataLayout.mjs").DataLayout} layout
 * @param {BackupInfo} chosen @param {{ from: string, now?: Date, step?: StepHook }} options
 */
export function restoreFromBackup(layout, chosen, { from, now, step }) {
  createBackup(layout, { kind: "restore", from, to: chosen.from, now, step });
  writeUpdateMarker(layout, { kind: "restore", backup: chosen.name, to: chosen.from });
  restoreBackup(layout, chosen.dir, { step });
  clearUpdateMarker(layout);
}

// ── 換版流程 ─────────────────────────────────────────────────────────────────

/**
 * 後端啟動失敗的原因是不是「資料庫比程式新」：靠後端日誌尾端的固定字樣（server.ts 的 migrate 失敗處）。
 * @param {readonly string[]} tail
 */
export function isDataNewerFailure(tail) {
  return tail.some((line) => line.includes(NEWER_DATA_LOG_MARKER));
}

/** 後端啟動失敗的原因是不是「還原後的資料換不了節點編號」（serverEntry.mjs 記下的固定字樣）。 @param {readonly string[]} tail */
export function isRenewalRefusedFailure(tail) {
  return tail.some((line) => line.includes(RENEWAL_REFUSED_LOG_MARKER));
}

/**
 * 可複製給開發者的診斷資訊（不放在主要訊息裡）。
 * @param {{ from: string, to: string, reason: string, tail: readonly string[], platform?: string }} info
 */
export function diagnosticsText({ from, to, reason, tail, platform = process.platform }) {
  return [
    "Onden desktop update diagnostics",
    `from: ${from}`,
    `to: ${to}`,
    `platform: ${platform}`,
    `reason: ${reason}`,
    "--- backend log (last lines) ---",
    ...tail.slice(-30),
  ].join("\n");
}

/** @param {unknown} error */
const failureTail = (error) => (error && typeof error === "object" && "tail" in error && Array.isArray(error.tail) ? /** @type {string[]} */ (error.tail) : []);
/** @param {unknown} error */
const failureReason = (error) => (error instanceof Error ? error.message.split("\n")[0] : String(error));

/**
 * 啟動後端並處理換版：
 *   上次更新沒做完（有更新標記）→ 先把資料還原成那份備份；
 *   資料是新建的或版本沒變 → 直接啟動；
 *   資料比程式新（版本檔記的升級檔比這個建置多）→ 不備份、不啟動、不動資料；
 *   版本變了 → 先備份（空間不足就不啟動）→ 寫標記 → 啟動（內含升級）→ 成功後記下新版本、清標記、清舊備份；
 *   啟動失敗 → 後端回報資料較新：不動資料、刪掉這份沒用的備份；其他：還原成備份。
 * 升級成功之後的收尾（版本檔、清舊備份）失敗只記警告。唯一例外：標記清不掉、版本檔也沒寫成時，下次啟動會
 * 把這段期間的資料還原掉，所以現在就停掉後端並還原（stopBackend）。
 * startBackend 失敗時必須已經停掉子程序（還原要動資料庫檔案）。
 * @template T
 * @param {{
 *   layout: import("./dataLayout.mjs").DataLayout, current: BuildStamp, startBackend: () => Promise<T>,
 *   keep?: number, now?: Date, freeBytes?: number, onWarn?: (message: string) => void, step?: StepHook,
 *   stopBackend?: (backend: T) => Promise<void>,
 * }} options
 * @returns {Promise<{ backend: T, backup: BackupInfo | null }>}
 */
export async function startWithSafeUpdate({ layout, current, startBackend, keep = DEFAULT_KEEP, now, freeBytes, onWarn, step, stopBackend }) {
  const to = stampLabel(current);
  recoverFromInterruptedUpdate(layout, { to, step });

  const previous = readVersionStamp(layout);
  const existing = hasExistingData(layout);
  const unchanged = previous !== null && stampLabel(previous) === to;

  /** 換不了號：不是這個版本開不了資料，還原它沒有用（還原後還是一樣），所以不還原、不留這次的備份，交給使用者選（review of #1937, point 6）。
   *  @param {unknown} error @param {{ from: string, backup?: BackupInfo }} at */
  const refusedRenewal = (error, at) => {
    const tail = failureTail(error);
    if (!isRenewalRefusedFailure(tail)) return;
    if (at.backup) { clearUpdateMarker(layout); rmSync(at.backup.dir, { recursive: true, force: true }); }
    throw new UpdateFailure("renewal_refused", { from: at.from, to, cause: error, diagnostics: diagnosticsText({ from: at.from, to, reason: failureReason(error), tail }) });
  };

  if (!existing || unchanged) {
    let backend;
    try {
      backend = await startBackend();
    } catch (error) {
      refusedRenewal(error, { from: to });
      throw error;
    }
    if (!unchanged) safely(() => writeVersionStamp(layout, current), onWarn, "write version file");
    return { backend, backup: null };
  }

  const from = previous ? stampLabel(previous) : "unknown";
  if (previous?.schema && current.schema && previous.schema > current.schema) {
    throw new UpdateFailure("data_newer", {
      from, to,
      diagnostics: diagnosticsText({ from, to, reason: `data schema ${previous.schema} is newer than this build's ${current.schema}`, tail: [] }),
    });
  }

  /** @type {BackupInfo} */
  let backup;
  try {
    backup = createBackup(layout, { kind: "update", from, to, now, freeBytes, step });
  } catch (error) {
    if (error instanceof InsufficientSpaceError) {
      throw new UpdateFailure("no_space", {
        from, to, cause: error, neededBytes: error.neededBytes, freeBytes: error.freeBytes,
        diagnostics: diagnosticsText({ from, to, reason: `not enough disk space: need ${error.neededBytes}, free ${error.freeBytes}`, tail: [] }),
      });
    }
    throw error;
  }
  writeUpdateMarker(layout, { kind: "upgrade", backup: backup.name, to });

  /** 升級失敗（或成功後收尾失敗到不能繼續用）：資料還原成備份。 @param {unknown} error @returns {never} */
  const rollBack = (error) => {
    refusedRenewal(error, { from, backup });
    const tail = failureTail(error);
    const diagnostics = diagnosticsText({ from, to, reason: failureReason(error), tail });
    if (isDataNewerFailure(tail)) {
      clearUpdateMarker(layout);
      rmSync(backup.dir, { recursive: true, force: true });
      throw new UpdateFailure("data_newer", { from, to, cause: error, diagnostics });
    }
    try {
      restoreBackup(layout, backup.dir, { step });
      clearUpdateMarker(layout);
    } catch (restoreError) {
      // 標記留著：下次啟動會把還原做完。
      throw new UpdateFailure("restore_failed", {
        from, to, cause: error, backupDir: backup.dir,
        diagnostics: `${diagnostics}\nrestore failed: ${failureReason(restoreError)}`,
      });
    }
    safely(() => pruneBackups(layout, keep), onWarn, "prune old backups");
    throw new UpdateFailure("rolled_back", { from, to, cause: error, backupDir: backup.dir, diagnostics });
  };

  /** @type {T} */
  let backend;
  try {
    backend = await startBackend();
  } catch (error) {
    return rollBack(error);
  }

  // 升級成功。版本檔先於清標記（標記在、版本檔已是目標版本＝升級成功，下次啟動只會清標記）。
  safely(() => writeVersionStamp(layout, current), onWarn, "write version file");
  try {
    clearUpdateMarker(layout);
  } catch (error) {
    const stamp = readVersionStamp(layout);
    if (stamp && stampLabel(stamp) === to) {
      onWarn?.(`clear update marker failed: ${failureReason(error)}`); // 標記殘留但無害：下次啟動只會清掉它
    } else {
      // 標記清不掉、版本檔也沒寫成：下次啟動會把這段期間的資料還原掉。不要繼續用，現在就還原（才剛啟動，幾乎沒有新資料）。
      await stopBackend?.(backend);
      return rollBack(new Error(`could not record the finished update: ${failureReason(error)}`));
    }
  }
  safely(() => pruneBackups(layout, keep), onWarn, "prune old backups");
  return { backend, backup };
}

/** @param {() => void} fn @param {((message: string) => void) | undefined} onWarn @param {string} what */
function safely(fn, onWarn, what) {
  try { fn(); } catch (error) { onWarn?.(`${what} failed: ${failureReason(error)}`); }
}

/**
 * 這個建置的版本與建置編號：stage.mjs 把 build.json 放在 server 資料夾旁。沒有（開發時沒設）＝編號空白，
 * 後端就不送建置標頭，網頁不會被告知「有新版」。
 * @param {string} serverRoot @param {string} version @returns {BuildStamp}
 */
export function readBuildInfo(serverRoot, version) {
  try {
    const parsed = JSON.parse(readFileSync(join(serverRoot, "build.json"), "utf8"));
    return { version, buildId: typeof parsed?.buildId === "string" ? parsed.buildId : "", ...(typeof parsed?.schema === "string" && parsed.schema ? { schema: parsed.schema } : {}) };
  } catch {
    return { version, buildId: "" };
  }
}
