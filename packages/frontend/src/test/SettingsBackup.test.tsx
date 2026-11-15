// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsModal from "../settings/SettingsModal";
import { exportDatabase, importDatabase } from "../lib/localDb";
import { setWorkspaceTimeZoneSource } from "../lib/localDate";
import { LocalDbError } from "../lib/localDbErrors";
import { dataSync } from "../lib/data";

// The real better-auth session store schedules its cleanup a second after the
// last unmount and touches `window` then; with the test file already torn down
// that surfaced as unhandled "window is not defined" errors. No test here needs a session.
vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }), signOut: vi.fn(), getSession: vi.fn() } }));
vi.mock("../lib/localDb", () => ({ exportDatabase: vi.fn(), importDatabase: vi.fn(), flushLocalDbSync: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** dataSync.downloadDrawings is a getter onto the engine; stub what it returns. */
function stubDownload(fn: (opts?: { force?: boolean }) => Promise<{ complete: boolean; missing: number | null }>) {
  // vi.spyOn types getters of non-function values only; the value is the stub.
  vi.spyOn(dataSync as unknown as { downloadDrawings: unknown }, "downloadDrawings", "get").mockReturnValue(fn);
}

/** The one button of a Your Data row, found by the row's title. */
const rowButton = (title: string) => within(screen.getByRole("group", { name: title })).getByRole("button");
const download = () => rowButton("Download this device's copy");
const restore = () => rowButton("Restore this device's copy");

async function open() {
  const user = userEvent.setup();
  const { baseElement: container } = render(<SettingsModal online onClose={vi.fn()} onConnect={vi.fn()} onImportDone={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Data and backup" }));
  // The .sqlite3 backup is an advanced setting (settings/registry.tsx).
  await user.click(screen.getByRole("button", { name: "Show advanced settings" }));
  const input = container.querySelector<HTMLInputElement>('input[accept=".sqlite3,.sqlite,.db"]')!;
  const file = new File(["audit"], "audit.sqlite3", { type: "application/x-sqlite3" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(5) });
  return { user, input, file };
}

describe("local backup settings", () => {
  it("names the backup by the workspace's day, not UTC's", async () => {
    // 2026-10-14 23:30 UTC is already 07:30 on the 15th in Taipei.
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T23:30:00Z"));
    const RealDate = Date;
    vi.stubGlobal("Date", class extends RealDate { constructor(...a: ConstructorParameters<typeof Date>) { super(...(a.length ? a : [RealDate.parse("2026-10-14T23:30:00Z")]) as [number]); } });
    setWorkspaceTimeZoneSource(() => "Asia/Taipei");
    vi.mocked(exportDatabase).mockResolvedValue(new File(["db"], "x.sqlite3"));
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    try {
      const { user } = await open();
      await user.click(download());
      await waitFor(() => expect(names).toEqual(["onden-backup-2026-10-15.sqlite3"]));
    } finally {
      vi.unstubAllGlobals();
      setWorkspaceTimeZoneSource(() => undefined);
    }
  });

  // D4: the bootstrap carries no drawings, so the backup first fetches the
  // ones this device lacks (forced: also hidden or on Save-Data), and says
  // how many are missing when it could not, instead of writing silently.
  it("fetches missing drawings before the backup, and says how many it could not", async () => {
    const order: string[] = [];
    const fetchDrawings = vi.fn(async (opts?: { force?: boolean }) => { order.push(`download:${opts?.force}`); return { complete: false, missing: 3 }; });
    stubDownload(fetchDrawings);
    vi.mocked(exportDatabase).mockImplementation(async () => { order.push("export"); return new File(["db"], "x.sqlite3"); });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    const { user } = await open();
    await user.click(download());
    expect(await screen.findByRole("status")).toHaveTextContent("3 drawings are missing from this backup");
    expect(order).toEqual(["download:true", "export"]);
  });

  it("says nothing about drawings when every one is on the device", async () => {
    stubDownload(vi.fn(async () => ({ complete: true, missing: 0 })));
    vi.mocked(exportDatabase).mockResolvedValue(new File(["db"], "x.sqlite3"));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    const { user } = await open();
    await user.click(download());
    await waitFor(() => expect(exportDatabase).toHaveBeenCalled());
    expect(document.querySelector(".settings-storage-notice")).toBeNull();
  });

  it("reports export failure in the form and enables a retry", async () => {
    vi.mocked(exportDatabase).mockRejectedValue(new Error("Worker unavailable"));
    const { user } = await open();
    await user.click(download());
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not create a local backup");
    expect(download()).toBeEnabled();
    expect(restore()).toBeEnabled();
  });
  it("keeps failure visible and allows the identical file to be selected again", async () => {
    vi.mocked(importDatabase).mockRejectedValue(new Error("Invalid backup"));
    const { user, input, file } = await open();
    for (let attempt = 1; attempt <= 2; attempt++) {
      await user.upload(input, file);
      await user.click(await screen.findByRole("button", { name: "Overwrite & import" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("The current local database was kept");
      expect(importDatabase).toHaveBeenCalledTimes(attempt);
      expect(input.value).toBe("");
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    }
  });
  it("explains why an unowned or other-account backup cannot replace current data", async () => {
    vi.mocked(importDatabase).mockRejectedValue(new LocalDbError("backup_foreign_account", "any worker text"));
    const { user, input, file } = await open();
    await user.upload(input, file);
    await user.click(await screen.findByRole("button", { name: "Overwrite & import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The backup must belong to the current account and server");
    expect(input.value).toBe("");
  });
  it("cancelling confirmation does not import or leave buttons disabled", async () => {
    const { user, input, file } = await open();
    await user.upload(input, file);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(importDatabase).not.toHaveBeenCalled();
    expect(restore()).toBeEnabled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });
  it("prevents both export and another import while a replacement is pending", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(importDatabase).mockReturnValue(new Promise((_, rejectPromise) => { reject = rejectPromise; }));
    const { user, input, file } = await open();
    await user.upload(input, file);
    await user.click(await screen.findByRole("button", { name: "Overwrite & import" }));
    expect(download()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
    reject(new Error("Storage full"));
    expect(await screen.findByRole("alert")).toBeVisible();
  });
});
