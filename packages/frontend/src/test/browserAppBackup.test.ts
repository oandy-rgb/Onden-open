// When the trial version reminds about a backup, and what its copied report holds (lib/browserAppBackup.ts, lib/browserAppDiagnostics.ts).
import { describe, expect, it } from "vitest";
import type { BridgeSaveState } from "@onden/markdown";
import { BACKUP_EVERY_DAYS, SAVES_BEFORE_REMINDER, backupDue, trialBackupFileName } from "../lib/browserAppBackup";
import { diagnosticsReport, recentIssues, recordIssue, versionLabel } from "../lib/browserAppDiagnostics";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 12, 0);

describe("backup reminder", () => {
  it("says nothing when nothing was saved since the last backup, however long ago", () => {
    expect(backupDue({ lastBackupAt: NOW - 90 * DAY, savesSince: 0, firstSeenAt: null }, NOW).due).toBe(false);
  });
  it("reminds after a week with something saved, counting from the last backup", () => {
    expect(backupDue({ lastBackupAt: NOW - (BACKUP_EVERY_DAYS - 1) * DAY, savesSince: 3, firstSeenAt: NOW - 99 * DAY }, NOW).due).toBe(false);
    const due = backupDue({ lastBackupAt: NOW - BACKUP_EVERY_DAYS * DAY, savesSince: 3, firstSeenAt: null }, NOW);
    expect(due).toMatchObject({ due: true, daysSince: BACKUP_EVERY_DAYS, neverBackedUp: false });
  });
  it("counts from the first opening when no backup was ever made", () => {
    const due = backupDue({ lastBackupAt: null, savesSince: 1, firstSeenAt: NOW - 8 * DAY }, NOW);
    expect(due).toMatchObject({ due: true, daysSince: 8, neverBackedUp: true });
    expect(backupDue({ lastBackupAt: null, savesSince: 1, firstSeenAt: NOW - 2 * DAY }, NOW).due).toBe(false);
  });
  it("reminds after many saves even on the first day", () => {
    expect(backupDue({ lastBackupAt: NOW, savesSince: SAVES_BEFORE_REMINDER, firstSeenAt: null }, NOW).due).toBe(true);
    expect(backupDue({ lastBackupAt: NOW, savesSince: SAVES_BEFORE_REMINDER - 1, firstSeenAt: null }, NOW).due).toBe(false);
  });
  it("names the file with the minute it was made, digits only", () => {
    expect(trialBackupFileName(NOW)).toMatch(/^onden-backup-\d{12}\.zip$/);
  });
});

describe("report text", () => {
  const save: BridgeSaveState = { store: "indexeddb", lastSavedAt: NOW - 1000, lastCopyMs: 900, lastCopyBytes: 6_000_000, unsaved: false, changes: 0, failed: false, journal: true, journalSkipped: 0 };
  const report = diagnosticsReport({ version: "2026-11-01 建置", browser: "Safari 17 on iOS", save, storage: { persistent: false, usedBytes: 7 * 1048576, quotaBytes: 900 * 1048576 }, files: { files: 3, bytes: 2048, store: "indexeddb" }, filesShown: true, lastBackupAt: null, now: NOW });

  it("says what is needed to understand a storage problem", () => {
    expect(report).toContain("不含任何筆記內容");
    expect(report).toContain("瀏覽器：Safari 17 on iOS");
    expect(report).toContain("儲存方式：瀏覽器的資料庫空間");
    expect(report).toContain("瀏覽器答應長期保留：否");
    expect(report).toContain("已用 7 MB，上限 900 MB");
    expect(report).toContain("修改紀錄（防止立刻關頁掉資料）：開");
    expect(report).toContain("上傳的檔案：3 個，佔 2 KB，存在瀏覽器的資料庫空間；顯示功能：正常");
    expect(report).toContain("上次備份：沒有");
  });
  it("holds no id, address or technical code", () => {
    expect(report).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(report).not.toMatch(/https?:\/\/|[{}]|_[a-z]+_/);
  });
  it("lists the last few issues by their labels only, newest last, at most five", () => {
    for (const what of ["一", "二", "三", "四", "五", "六"]) recordIssue(`備份失敗${what}`, NOW);
    recordIssue("備份失敗六", NOW); // the same label twice in a row is one entry
    expect(recentIssues().map((i) => i.what)).toEqual(["備份失敗二", "備份失敗三", "備份失敗四", "備份失敗五", "備份失敗六"]);
  });
  it("labels a version by its tag, its build day, or 開發版", () => {
    expect(versionLabel("anything", "試用 3")).toBe("試用 3");
    expect(versionLabel((Date.UTC(2026, 10, 1, 8)).toString(36))).toMatch(/^2026-11-01 建置$/);
    expect(versionLabel("dev")).toBe("開發版");
  });
});
