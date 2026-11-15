// The text a person copies into a bug report from the trial version: what is needed to understand a storage or
// update problem, and nothing from the notes (no titles, no text, no tags, no names). Pure, so it is tested as text.

import type { BridgeSaveState, BrowserAppMedia } from "@onden/markdown";
import { dateIdAt, dateTimeId } from "./localDate";
import type { StorageStatus } from "./storagePersist";

const MAX_ISSUES = 5;
const issues: Array<{ at: number; what: string }> = [];

/** A short, content-free label ("the copy could not be written") for the report's 「最近的問題」 list. */
export function recordIssue(what: string, now: number = Date.now()): void {
  if (issues[issues.length - 1]?.what === what) return;
  issues.push({ at: now, what });
  if (issues.length > MAX_ISSUES) issues.shift();
}

export function recentIssues(): ReadonlyArray<{ at: number; what: string }> {
  return issues;
}

const STORE_WORDS: Record<BridgeSaveState["store"], string> = { opfs: "瀏覽器的檔案空間", indexeddb: "瀏覽器的資料庫空間", none: "沒有可用的儲存空間" };
const mib = (bytes: number | null) => (bytes === null ? "不明" : `${Math.round(bytes / 1048576)} MB`);
/** Uploaded files are often small: a megabyte count would say "0 MB" for a few pictures. */
const fileSize = (bytes: number) => (bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : mib(bytes));
const yesNo = (value: boolean | null) => (value === null ? "不明" : value ? "是" : "否");

/** A version a person can read: builds made by the script are dated; a tag given at publish time is shown as is. */
export function versionLabel(buildId: string, tag?: string): string {
  if (tag) return tag;
  const at = parseInt(buildId, 36);
  return Number.isFinite(at) && at > 1.6e12 && at < 4e12 ? `${dateIdAt(new Date(at))} 建置` : "開發版";
}

export type DiagnosticsInput = {
  version: string;
  browser: string;
  save: BridgeSaveState | null;
  storage: StorageStatus;
  /** The uploaded files the browser holds (null: the worker did not say). */
  files: BrowserAppMedia | null;
  /** Whether the Service Worker that shows them is in charge of the page. */
  filesShown: boolean;
  lastBackupAt: number | null;
  now: number;
};

export function diagnosticsReport({ version, browser, save, storage, files, filesShown, lastBackupAt, now }: DiagnosticsInput): string {
  const when = (at: number | null) => (at === null ? "沒有" : dateTimeId(new Date(at)));
  const lines = [
    "Onden 試用版診斷資訊（不含任何筆記內容）",
    `版本：${version}`,
    `瀏覽器：${browser}`,
    `儲存方式：${save ? STORE_WORDS[save.store] : "尚未開始"}`,
    `瀏覽器答應長期保留：${yesNo(storage.persistent)}`,
    `空間：已用 ${mib(storage.usedBytes)}，上限 ${mib(storage.quotaBytes)}`,
    `上傳的檔案：${files ? `${files.files} 個，佔 ${fileSize(files.bytes)}，存在${STORE_WORDS[files.store]}` : "不明"}；顯示功能：${filesShown ? "正常" : "沒有啟用"}`,
    `修改紀錄（防止立刻關頁掉資料）：${save ? (save.journal ? "開" : "關") : "不明"}${save && save.journalSkipped > 0 ? `，${save.journalSkipped} 次太大沒記錄` : ""}`,
    `上次存檔：${when(save?.lastSavedAt ?? null)}`,
    `還有沒存的修改：${save ? yesNo(save.unsaved) : "不明"}`,
    `上次存檔失敗：${save ? yesNo(save.failed) : "不明"}`,
    `上次備份：${when(lastBackupAt)}`,
    `回報時間：${when(now)}`,
    `最近的問題：${issues.length === 0 ? "沒有" : issues.map((i) => `${when(i.at)} ${i.what}`).join("；")}`,
  ];
  return lines.join("\n");
}
