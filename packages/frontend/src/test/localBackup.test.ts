import { beforeEach, describe, expect, it, vi } from "vitest";
import { chooseLocalBackupFolder, switchToBrowserStorage } from "../lib/localBackup";
import { exportDatabase, flushLocalDbSync } from "../lib/localDb";
import { getStoragePref, pickDirectory, readDbFromDir, setStoragePref, storeDirHandle, writeDbToDir } from "../lib/fileSystemStorage";

vi.mock("../lib/localDb", () => ({ exportDatabase: vi.fn(), flushLocalDbSync: vi.fn() }));
vi.mock("../lib/fileSystemStorage", () => ({
  getStoragePref: vi.fn(), pickDirectory: vi.fn(), readDbFromDir: vi.fn(),
  setStoragePref: vi.fn(), storeDirHandle: vi.fn(), writeDbToDir: vi.fn(),
}));
const folder = { name: "Empty audit folder" } as FileSystemDirectoryHandle;
const file = new File(["snapshot"], "onden.sqlite3");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getStoragePref).mockReturnValue("opfs");
  vi.mocked(pickDirectory).mockResolvedValue(folder);
  vi.mocked(readDbFromDir).mockResolvedValue(null);
  vi.mocked(exportDatabase).mockResolvedValue(file);
});

describe("storage location changes", () => {
  it("does not activate a folder until its file and directory setting are committed", async () => {
    let finishFile!: () => void; let finishSetting!: () => void;
    vi.mocked(writeDbToDir).mockReturnValue(new Promise((resolve) => { finishFile = resolve; }));
    vi.mocked(storeDirHandle).mockReturnValue(new Promise((resolve) => { finishSetting = resolve; }));
    const change = chooseLocalBackupFolder();
    await vi.waitFor(() => expect(writeDbToDir).toHaveBeenCalledWith(folder, file));
    expect(storeDirHandle).not.toHaveBeenCalled();
    finishFile();
    await vi.waitFor(() => expect(storeDirHandle).toHaveBeenCalledWith(folder));
    expect(setStoragePref).not.toHaveBeenCalled();
    finishSetting();
    expect(await change).toBe(true);
    expect(setStoragePref).toHaveBeenCalledWith("fs-access");
  });
  it("treats cancelling the picker as a no-op", async () => {
    vi.mocked(pickDirectory).mockResolvedValue(null);
    expect(await chooseLocalBackupFolder()).toBe(false);
    expect(exportDatabase).not.toHaveBeenCalled();
    expect(setStoragePref).not.toHaveBeenCalled();
  });
  it("protects an existing database in the selected folder", async () => {
    vi.mocked(readDbFromDir).mockResolvedValue(new ArrayBuffer(1));
    await expect(chooseLocalBackupFolder()).rejects.toThrow(/already contains/);
    expect(writeDbToDir).not.toHaveBeenCalled();
    expect(storeDirHandle).not.toHaveBeenCalled();
  });
  it.each(["read", "export", "file", "setting"])("keeps the original location on %s failure", async (stage) => {
    const failure = new Error("Storage failure");
    const method = { read: readDbFromDir, export: exportDatabase, file: writeDbToDir, setting: storeDirHandle }[stage]!;
    vi.mocked(method).mockRejectedValueOnce(failure);
    await expect(chooseLocalBackupFolder()).rejects.toBe(failure);
    expect(setStoragePref).not.toHaveBeenCalled();
    if (stage !== "setting") expect(storeDirHandle).not.toHaveBeenCalled();
  });
  it("has no fallible preference write after replacing an already-active directory handle", async () => {
    vi.mocked(getStoragePref).mockReturnValue("fs-access");
    await expect(chooseLocalBackupFolder()).resolves.toBe(true);
    expect(storeDirHandle).toHaveBeenCalledWith(folder);
    expect(setStoragePref).not.toHaveBeenCalled();
  });
  it("does not switch back to the browser when its latest snapshot cannot be saved", async () => {
    vi.mocked(flushLocalDbSync).mockRejectedValueOnce(new Error("Quota"));
    await expect(switchToBrowserStorage()).rejects.toThrow("Quota");
    expect(setStoragePref).not.toHaveBeenCalled();
    await switchToBrowserStorage();
    expect(setStoragePref).toHaveBeenCalledWith("opfs");
  });
});
