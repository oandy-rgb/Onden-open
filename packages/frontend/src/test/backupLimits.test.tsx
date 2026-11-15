// Backup size limits on the page (lib/data/backupLimits.ts, settings/FullBackupSetting.tsx): the restore limit is
// stated beside the chooser, a download bigger than it is said so (it still downloads), and an upload bigger than it
// is refused before sending, in plain units.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DEFAULT_MAX_BACKUP_REQUEST_BYTES } from "@onden/markdown";
import { FullBackupDownload, FullBackupRestore } from "../settings/FullBackupSetting";
import { backupLimits, backupRestore, sizeLabel } from "../lib/data";
import { WriteActionError } from "../lib/data/writeErrors";
import { ensureWordingFor, serverErrorMessage } from "../lib/serverErrors";
import { setLocalePref } from "../lib/i18n";
import type { SettingContext } from "../lib/settingsTypes";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const ctx = { online: true, onImportDone: () => undefined } as unknown as SettingContext;

/** The server answers these paths; anything else fails like an unreachable server. */
function serve(answers: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    if (path in answers) return new Response(JSON.stringify(answers[path]), { headers: { "Content-Type": "application/json" } });
    return new Response("{}", { status: 404 });
  }));
}

afterEach(() => { vi.unstubAllGlobals(); setLocalePref("en"); });

describe("backup size limits", () => {
  it("names sizes in plain units", () => {
    expect(sizeLabel(16 * GB)).toBe("16 GB");
    expect(sizeLabel(1.5 * GB)).toBe("1.5 GB");
    expect(sizeLabel(800 * MB)).toBe("800 MB");
  });

  it("asks the server for its limit, and falls back to the default when it cannot answer", async () => {
    serve({ "/api/backup/restore/limit": { max_bytes: 5 * GB } });
    expect(await backupLimits.restoreLimitBytes()).toBe(5 * GB);
    serve({});
    expect(await backupLimits.restoreLimitBytes()).toBe(DEFAULT_MAX_BACKUP_REQUEST_BYTES);
    expect(await backupLimits.downloadBytes()).toBeNull();
  });

  it("states the limit beside the file chooser", async () => {
    serve({ "/api/backup/restore/limit": { max_bytes: 16 * GB } });
    render(<FullBackupRestore ctx={ctx} />);
    expect(await screen.findByText("Restores backups up to 16 GB.")).toBeTruthy();
  });

  it("warns that a download is more than this server restores, in plain words", async () => {
    serve({
      "/api/backup/size": { bytes: 3 * GB }, "/api/backup/restore/limit": { max_bytes: 2 * GB },
      "/api/backup/history-size": { notes: 0, versions: 0, bytes: 0 },
    });
    render(<FullBackupDownload ctx={ctx} />);
    expect(await screen.findByText(/This backup is about 3 GB, more than the 2 GB this server restores\. You can still download it/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
  });

  it("says nothing when the backup fits", async () => {
    serve({
      "/api/backup/size": { bytes: 1 * GB }, "/api/backup/restore/limit": { max_bytes: 16 * GB },
      "/api/backup/history-size": { notes: 0, versions: 0, bytes: 0 },
    });
    render(<FullBackupDownload ctx={ctx} />);
    await screen.findByRole("link", { name: "Download" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(/more than the/)).toBeNull();
  });

  it("refuses an upload over the limit before sending it", async () => {
    serve({ "/api/backup/restore/limit": { max_bytes: 2 * GB } });
    const file = new File(["x"], "backup.zip");
    Object.defineProperty(file, "size", { value: 3 * GB });
    await expect(backupRestore.upload(file)).rejects.toThrow(new WriteActionError("The backup is larger than the 2 GB this server restores."));
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(["/api/backup/restore/limit"]);
  });

  it("says a full disk plainly, with no code", async () => {
    await ensureWordingFor("backup_no_room"); // a rarer code's wording loads on use
    const message = serverErrorMessage("backup_no_room", undefined);
    expect(message).toBe("This server does not have enough free space to receive the backup. Nothing was uploaded.");
    setLocalePref("zh-TW");
    expect(serverErrorMessage("backup_no_room", undefined)).toBe("伺服器的剩餘空間不夠接收這個備份，沒有上傳任何東西。");
  });
});
