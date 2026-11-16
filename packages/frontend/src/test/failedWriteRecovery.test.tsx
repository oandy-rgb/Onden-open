// Account isolation has its own suite (accountStorage.test.ts); these bind one account.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, cleanup, waitFor } from "@testing-library/react";

// Data-loss trust on the mobile capture path: when the offline write-queue
// truly FAILS to persist a write, the typed content must NOT vanish behind a
// transient toast — FailedWriteRecovery keeps it visible + recoverable.

// addPendingWrite is the persist step that can fail (quota / OPFS). Default it
// to reject so a queueWrite() triggers the failed-queue path; individual tests
// flip it to resolve to exercise a successful retry.
const pendingRows: unknown[] = vi.hoisted(() => []);
const { addPendingWriteMock, apiMock } = vi.hoisted(() => ({ addPendingWriteMock: vi.fn(), apiMock: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: apiMock }));
vi.mock("../lib/localDb", () => ({
  addPendingWrite: addPendingWriteMock,
  getPendingWrites: vi.fn(async () => pendingRows),
  clearPendingWrite: vi.fn(async () => { pendingRows.length = 0; }),
  catchUpWithOtherTabs: vi.fn(async () => {}),
  getRejectedWrites: vi.fn(async () => []),
  dismissRejectedWrite: vi.fn(async () => {}),
  storeRejectedWrite: vi.fn(),
}));

import { getRejectedWrites, dismissRejectedWrite, storeRejectedWrite } from "../lib/localDb";
import { refreshRecoveryWrites, preserveDirectRejection } from "../lib/data/writeRecovery";
import FailedWriteRecovery from "../components/FailedWriteRecovery";
import { OFFLINE_QUEUE_FAILED_EVENT, queueWrite, type OfflineQueueFailedDetail } from "../lib/data/writeQueue";
import { setPending, getPendingCount } from "../lib/data/syncStatus";
import { accountStorageKey, bindAccountStorage } from "../lib/accountStorage";
import { reportWriteFailure } from "../lib/data/writeErrors";
import { noteWriter } from "../lib/data";
import { resetAppState, setData } from "../lib/appStore";
import { ownerData } from "./ownerData";
import { ApiError } from "../lib/api";
import { readFileSync } from "node:fs";
import path from "node:path";

bindAccountStorage("u", "");
const STORAGE_KEY = accountStorageKey("onden.lostWrites");

function dispatchFailure(detail: OfflineQueueFailedDetail) {
  act(() => {
    window.dispatchEvent(new CustomEvent(OFFLINE_QUEUE_FAILED_EVENT, { detail }));
  });
}

describe("FailedWriteRecovery (data-loss recovery)", () => {
  beforeEach(async () => {
    cleanup();
    localStorage.clear();
    setPending(0);
    addPendingWriteMock.mockReset();
    apiMock.mockReset();
    pendingRows.length = 0;
    addPendingWriteMock.mockRejectedValue(new Error("quota"));
    // The refused-input suite below loads a refused row into the module's
    // recovery store; start these tests with none.
    vi.mocked(getRejectedWrites).mockResolvedValue([]);
    await refreshRecoveryWrites();
  });

  it("surfaces the lost text + recovery actions when a write fails to queue", () => {
    render(<FailedWriteRecovery />);
    // Nothing until a failure happens.
    expect(screen.queryByText("This change couldn't be saved")).toBeNull();

    dispatchFailure({ method: "POST", path: "/api/nodes", body: JSON.stringify({ title: "bus-stop idea", markdown: "remember the milk" }) });

    expect(screen.getByText("This change couldn't be saved")).toBeInTheDocument();
    // The actual typed content is preserved + shown (not silently dropped).
    expect(screen.getByText(/remember the milk/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy to clipboard" })).toBeInTheDocument();
  });

  it("mirrors the lost write to localStorage so it survives a reload", () => {
    const { unmount } = render(<FailedWriteRecovery />);
    dispatchFailure({ method: "POST", path: "/api/nodes", body: JSON.stringify({ markdown: "do not lose me" }) });
    expect(localStorage.getItem(STORAGE_KEY)).toContain("do not lose me");

    // Simulate a reload: remount from scratch — the banner re-seeds from storage.
    unmount();
    render(<FailedWriteRecovery />);
    expect(screen.getByText(/do not lose me/)).toBeInTheDocument();
  });

  it("warns when a directly refused input could not be persisted, keeps it across remount, and never offers replay", async () => {
    vi.mocked(storeRejectedWrite).mockRejectedValueOnce(new Error("disk full"));
    const { unmount } = render(<FailedWriteRecovery />);
    await act(async () => {
      await expect(preserveDirectRejection({ method: "PATCH", path: "/api/nodes/n", body: '{"markdown":"direct input"}', idemKey: "direct-key" }, "Denied")).rejects.toMatchObject({ name: "WriteStorageError" });
    });
    expect(screen.getByText("direct input")).toBeInTheDocument();
    expect(screen.getByText(/Recovery storage is not confirmed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    unmount(); render(<FailedWriteRecovery />);
    expect(screen.getByText("direct input")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("Try again re-queues through the SAME offline path and clears the banner on success", async () => {
    render(<FailedWriteRecovery />);
    dispatchFailure({ method: "POST", path: "/api/nodes", body: JSON.stringify({ markdown: "retry me" }) });
    expect(screen.getByText(/retry me/)).toBeInTheDocument();

    // This time persistence succeeds — the retry should land in the real queue.
    addPendingWriteMock.mockImplementation(async (method, path, body, idem_key) => { pendingRows.push({ id: 1, method, path, body, idem_key, attempts: 0 }); });
    apiMock.mockResolvedValue({});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });

    expect(addPendingWriteMock).toHaveBeenCalledWith("POST", "/api/nodes", JSON.stringify({ markdown: "retry me" }), expect.any(String));
    // Queued AND sent: the entry is gone from the panel, so nothing may wait for a later sync round.
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/api/nodes", expect.objectContaining({ method: "POST", body: JSON.stringify({ markdown: "retry me" }) })));
    await waitFor(() => expect(getPendingCount()).toBe(0));
    expect(screen.queryByText(/retry me/)).toBeNull(); // banner cleared
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull(); // mirror cleared
  });

  it("a real queueWrite failure drives the recovery banner end-to-end", async () => {
    render(<FailedWriteRecovery />);
    // addPendingWrite rejects (default) → queueWrite fires the failed event.
    await act(async () => {
      await queueWrite("PATCH", "/api/nodes/x", JSON.stringify({ markdown: "edge case" }));
    });
    expect(screen.getByText(/edge case/)).toBeInTheDocument();
    expect(getPendingCount()).toBe(0); // the optimistic bump was taken back
  });

  it("retains the recovery copy while a retry is still committing", async () => {
    render(<FailedWriteRecovery />);
    dispatchFailure({ method: "POST", path: "/api/nodes", body: "keep during commit", idemKey: "stable-key" });
    let commit!: () => void;
    addPendingWriteMock.mockImplementation(() => new Promise<void>((resolve) => { commit = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(commit).toBeTypeOf("function"));
    expect(localStorage.getItem(STORAGE_KEY)).toContain("keep during commit");
    expect(screen.getByText("keep during commit")).toBeInTheDocument();
    await act(async () => { commit(); });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("reuses a failed write's key after reload and repeated storage failure", async () => {
    const { unmount } = render(<FailedWriteRecovery />);
    await act(async () => {
      await queueWrite("POST", "/api/nodes", "do not duplicate", "original-key");
    });
    unmount();
    render(<FailedWriteRecovery />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(addPendingWriteMock).toHaveBeenLastCalledWith("POST", "/api/nodes", "do not duplicate", "original-key");
    expect(screen.getAllByText("do not duplicate")).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toHaveLength(1);
    addPendingWriteMock.mockResolvedValue(undefined);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(addPendingWriteMock).toHaveBeenLastCalledWith("POST", "/api/nodes", "do not duplicate", "original-key");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("Dismiss removes the entry without retrying", () => {
    render(<FailedWriteRecovery />);
    dispatchFailure({ method: "POST", path: "/api/nodes", body: JSON.stringify({ markdown: "throwaway" }) });
    expect(screen.getByText(/throwaway/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/throwaway/)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("rejected queued input", () => {
  const row = { id: 23, method: "PATCH", path: "/api/nodes/private", body: '{"markdown":"My offline input"}',
    idem_key: "original-key", attempts: 0, rejection: "Permission revoked" };
  beforeEach(async () => {
    cleanup(); localStorage.clear();
    vi.mocked(getRejectedWrites).mockResolvedValue([row]);
    vi.mocked(dismissRejectedWrite).mockReset().mockResolvedValue(undefined);
    await refreshRecoveryWrites();
  });
  it("loads refused input without a new failure event and never offers original-request retry", async () => {
    render(<FailedWriteRecovery />);
    expect(await screen.findByText("This change was rejected")).toBeInTheDocument();
    expect(screen.getByText("My offline input")).toBeInTheDocument();
    expect(screen.getByText("Permission revoked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy to clipboard" })).toBeEnabled();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
  it("does not repeat a title already on the first line of its markdown", async () => {
    vi.mocked(getRejectedWrites).mockResolvedValue([{ ...row, body: JSON.stringify({ title: "My title", markdown: "My title\n\nMy offline input" }) }]);
    await refreshRecoveryWrites();
    render(<FailedWriteRecovery />);
    expect(screen.getByText(/My title/).textContent).toBe("My title\n\nMy offline input");
  });
  it("can minimize and reopen without deleting or resending the input", async () => {
    render(<FailedWriteRecovery />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize recovery panel" }));
    expect(screen.queryByText("My offline input")).toBeNull();
    expect(dismissRejectedWrite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Recovery inputs (1)" }));
    expect(screen.getByText("My offline input")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
  it("copies only the recognizable input", async () => {
    const copy = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    render(<FailedWriteRecovery />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" })); });
    expect(copy).toHaveBeenCalledWith("My offline input");
  });
  it("keeps the entry and disables repeated dismissal while the removal is saving", async () => {
    let commit!: () => void;
    vi.mocked(dismissRejectedWrite).mockImplementationOnce(() => new Promise<void>(resolve => { commit = resolve; }));
    render(<FailedWriteRecovery />);
    fireEvent.click(screen.getByRole("button", { name: "Remove recovery copy" }));
    expect(screen.getByText("My offline input")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove recovery copy" })).toBeDisabled();
    await act(async () => { commit(); });
    expect(dismissRejectedWrite).toHaveBeenCalledExactlyOnceWith(row);
    expect(screen.queryByText("My offline input")).toBeNull();
  });
  it("keeps the visible input after failed removal", async () => {
    vi.mocked(dismissRejectedWrite).mockRejectedValueOnce(new Error("disk full"));
    render(<FailedWriteRecovery />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove recovery copy" })); });
    expect(screen.getByText("My offline input")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove recovery copy" })).toBeEnabled();
  });
});

describe("recovery shows only what the user typed", () => {
  let storeId = 500;
  beforeEach(async () => {
    cleanup(); localStorage.clear();
    storeId = 500;
    vi.mocked(getRejectedWrites).mockResolvedValue([]);
    vi.mocked(dismissRejectedWrite).mockReset().mockResolvedValue(undefined);
    vi.mocked(storeRejectedWrite).mockReset().mockImplementation(async (request, rejection) => ({ ...request, id: ++storeId, attempts: 0, rejection }));
    await refreshRecoveryWrites();
  });
  const direct = (path: string, body: string, key: string, method = "POST") =>
    act(async () => { await preserveDirectRejection({ method: method as "POST", path, body, idemKey: key }, "Tag name already in use."); });

  it("a refused tag name shows the name as plain text, never the request JSON", async () => {
    render(<FailedWriteRecovery />);
    await direct("/api/tags", JSON.stringify({ id: "ac3f04da-0000-4000-8000-000000000000", name: "重複" }), "k1");
    expect(screen.getByText("重複")).toBeInTheDocument();
    expect(screen.getByText("Tag name already in use.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ac3f04da|"name"|\{"/);
  });

  it("typed text refused because its note was deleted elsewhere can be kept as a new note; a note that still exists offers no such button", async () => {
    resetAppState({ data: { ...ownerData, nodes: [{ id: "here", title: "Here", markdown: "", node_type: "content" } as never] } });
    const create = vi.spyOn(noteWriter, "create").mockResolvedValue({ status: "synced", node: { id: "new" } } as never);
    render(<FailedWriteRecovery />);
    await act(async () => { await preserveDirectRejection({ method: "PATCH", path: "/api/nodes/here", body: JSON.stringify({ markdown: "kept text" }), idemKey: "g0" }, "Refused."); });
    expect(screen.queryByRole("button", { name: "Keep as a new note" })).toBeNull();
    await act(async () => { await preserveDirectRejection({ method: "PATCH", path: "/api/nodes/gone", body: JSON.stringify({ markdown: "typed after it was deleted\nsecond line" }), idemKey: "g1" }, "This note is no longer available. Keep your draft and reopen the note."); });
    expect(screen.getAllByRole("button", { name: "Keep as a new note" })).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep as a new note" })); });
    expect(create).toHaveBeenCalledExactlyOnceWith({ title: "typed after it was deleted", markdown: "typed after it was deleted\nsecond line" });
    expect(screen.queryByText("This note is no longer available. Keep your draft and reopen the note.")).toBeNull();
    // A refused creation keeps the entry.
    create.mockRejectedValueOnce(new Error("refused"));
    await act(async () => { await preserveDirectRejection({ method: "PATCH", path: "/api/nodes/gone2", body: JSON.stringify({ markdown: "second" }), idemKey: "g2" }, "Refused."); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep as a new note" })); });
    expect(screen.getByText("second")).toBeInTheDocument();
    create.mockRestore();
    setData((data) => data);
  });

  it("an id-only refusal creates no entry", async () => {
    render(<FailedWriteRecovery />);
    await direct("/api/nodes/65025fb8/duplicate", JSON.stringify({ id: "65025fb8-0000-4000-8000-000000000000" }), "k2");
    expect(storeRejectedWrite).not.toHaveBeenCalled();
    expect(screen.queryByText("This change was rejected")).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(document.body.textContent).not.toMatch(/65025fb8/);
  });

  it("a refused note save holding text the newer refusal lacks stays its own entry; one it covers collapses", async () => {
    vi.mocked(storeRejectedWrite).mockImplementation(async (request, rejection) => ({ ...request, id: ++storeId, attempts: 0, rejection }));
    render(<FailedWriteRecovery />);
    const save = (fields: object, key: string) => direct("/api/nodes/n1", JSON.stringify(fields), key, "PATCH");
    await save({ title: "T".repeat(501), markdown: "typed before the reload" }, "n1");
    await save({ title: "T".repeat(501), markdown: "typed before the reload\nand a bit more" }, "n2");
    expect(screen.getAllByText("This change was rejected"), "the newer copy holds all the older text").toHaveLength(1);
    await save({ title: "T".repeat(501) }, "n3");
    expect(screen.getAllByText("This change was rejected"), "a title-only refusal does not hide the typed body").toHaveLength(2);
  });

  it("repeated refusals of one number cell collapse into one entry that can be dismissed", async () => {
    const rows: Array<{ id: number; method: string; path: string; body: string | null; idem_key: string; attempts: number; rejection: string }> = [];
    vi.mocked(storeRejectedWrite).mockImplementation(async (request, rejection) => {
      const row = { ...request, id: ++storeId, attempts: 0, rejection }; rows.push(row); return row;
    });
    render(<FailedWriteRecovery />);
    for (const [i, value] of ["abc", "abc", "1,200"].entries()) {
      await direct("/api/nodes/n1/attributes/price", JSON.stringify({ value, value_type: "number" }), `c${i}`, "PUT");
    }
    expect(screen.getAllByText("This change was rejected")).toHaveLength(1);
    expect(screen.getByText("1,200")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/value_type/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove recovery copy" })); });
    // The second "abc" is the same refusal as the first: kept once.
    expect(dismissRejectedWrite).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("This change was rejected")).toBeNull();
  });

  it("a refusal that creates a recovery entry is not also toasted; one without an entry is toasted once", async () => {
    vi.mocked(storeRejectedWrite).mockImplementation(async (request, rejection) => ({ ...request, id: ++storeId, attempts: 0, rejection }));
    const notify = vi.fn();
    const duplicate = new ApiError(409, JSON.stringify({ error: "tag_name_conflict" }));
    await act(async () => { await preserveDirectRejection({ method: "POST", path: "/api/tags", body: JSON.stringify({ name: "重複" }), idemKey: "t1" }, "Tag name already in use.", duplicate); });
    reportWriteFailure(duplicate, notify);
    expect(notify).not.toHaveBeenCalled();

    const idOnly = new ApiError(403, JSON.stringify({ error: "forbidden" }));
    await act(async () => { await preserveDirectRejection({ method: "DELETE", path: "/api/nodes/n1", body: null, idemKey: "t2" }, "Denied", idOnly); });
    reportWriteFailure(idOnly, notify);
    reportWriteFailure(idOnly, notify);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("repeated field refusals are not toasted, and the entry keeps the latest value for the copy button", async () => {
    vi.mocked(storeRejectedWrite).mockImplementation(async (request, rejection) => ({ ...request, id: ++storeId, attempts: 0, rejection }));
    const notify = vi.fn();
    render(<FailedWriteRecovery />);
    for (const [i, value] of ["abc", "1,200"].entries()) {
      const refused = new ApiError(422, JSON.stringify({ error: "field_invalid" }));
      await act(async () => { await preserveDirectRejection({ method: "PUT", path: "/api/nodes/n1/attributes/price", body: JSON.stringify({ value }), idemKey: `f${i}` }, "r", refused); });
      reportWriteFailure(refused, notify);
    }
    expect(notify).not.toHaveBeenCalled();
    expect(screen.getAllByText("This change was rejected")).toHaveLength(1);
    expect(screen.getByText("1,200")).toBeInTheDocument(); // latest value only; Copy copies it
    expect(screen.queryByText("abc")).toBeNull();
  });

  it("the card sits in a corner and its container never intercepts clicks outside the cards", () => {
    const css = readFileSync(path.join(__dirname, "../components/FailedWriteRecovery.css"), "utf8");
    const container = css.match(/\.failed-write-recovery \{[^}]*\}/)![0];
    expect(container).toMatch(/pointer-events:\s*none/);
    expect(container).toMatch(/bottom:/);
    expect(container).not.toMatch(/\btop:/);
    expect(css).toMatch(/\.fwr-card[^{]*\{\s*pointer-events:\s*auto/);
  });
  it("the minimized button is pinned like the open panel, so a phone's bottom nav cannot cover it", () => {
    render(<FailedWriteRecovery />);
    dispatchFailure({ method: "POST", path: "/api/nodes", body: JSON.stringify({ markdown: "kept text" }) });
    const open = document.querySelector(".failed-write-recovery")!;
    expect(open.classList.contains("ui-layer")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Minimize recovery panel" }));
    const collapsed = document.querySelector(".failed-write-recovery.fwr-collapsed")!;
    expect(collapsed.classList.contains("ui-layer")).toBe(true);
  });

  it("phone placement rules match where the portalled elements are: the clearance lives on :root, not .app-shell", () => {
    const read = (file: string) => readFileSync(path.join(__dirname, file), "utf8");
    const global = read("../styles/global.css");
    const nav = read("../components/MobileNav.css");
    expect(global).not.toMatch(/\.app-shell:has\([^)]*(fwr|failed-write-recovery)/);
    expect(global).toMatch(/:root:has\(\.fwr-collapsed\) \.toast-stack/);
    expect(global).toMatch(/:root:has\(\.failed-write-recovery:not\(\.fwr-collapsed\)\) \.toast-stack/);
    expect(nav).not.toMatch(/\.app-shell[^{]*\{[^}]*--mobile-bottom-clearance/);
    expect(nav).toMatch(/:root \{[^}]*--mobile-bottom-clearance: 70px/);
    expect(nav).toMatch(/:root:has\(\.mobile-sync-strip\) \{ --mobile-bottom-clearance: 100px/);
  });
});
