// The sync status says WHY sync is not moving, in both directions: what the last
// failed send was (still retrying, signed out, stuck behind one note) and that
// the server's newer content is not arriving while the page still says
// "connected". Each sentence is plain words: no codes, statuses or ids.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const writes = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => writes.list),
  getOldestPendingWriteAt: vi.fn(async () => "2026-11-12 08:00:00"),
}));

import SyncStatus, { useSyncTrouble } from "../components/SyncStatus";
import { resetAppState } from "../lib/appStore";
import { noWorkspaceData } from "../lib/api";
import { setLocalePref } from "../lib/i18n";
import "../lib/i18n.zh-TW";
import { refreshPendingCount, setPending, STUCK_AFTER_ATTEMPTS } from "../lib/data/syncStatus";
import { setIncomingProblem } from "../lib/data/incomingStatus";
import { sendFailureReason } from "../lib/data/writeErrors";
import { ApiError } from "../lib/api";

const TECHNICAL = /\b(401|500|502|503|HTTP|JSON|uuid|unauthorized|ApiError|TypeError|Failed to fetch)\b|[a-z]+_[a-z]+/;
const noteWrite = { id: 1, method: "PATCH", path: "/api/nodes/n1", body: "{}", idem_key: "k", attempts: 0 };

/** `n` changes waiting in the queue (none of them stuck yet). */
const waiting = (n: number) => { writes.list = Array.from({ length: n }, (_, i) => ({ ...noteWrite, id: i + 1 })); };

function Trouble() {
  const trouble = useSyncTrouble();
  return <span data-testid="trouble">{trouble ? `${trouble.kind}:${trouble.label}` : ""}</span>;
}
const open = (onOpenNote?: (id: string) => void) =>
  render(<><SyncStatus expanded onSyncNow={vi.fn()} onOpenNote={onOpenNote} /><Trouble /></>);
const text = () => document.body.textContent ?? "";

beforeEach(async () => {
  setLocalePref("en");
  resetAppState({ data: { ...noWorkspaceData, nodes: [{ id: "n1", title: "Trip plan", markdown: "", source_type: "manual", node_type: "content", slug: "n1" }] }, online: true });
  writes.list = [];
  setPending(0); setIncomingProblem(null);
  await refreshPendingCount(null); // clears a stuck head left by an earlier test
});
afterEach(() => { cleanup(); setLocalePref("system"); setPending(0); setIncomingProblem(null); });

describe("sending: still retrying, before it counts as stuck", () => {
  const cases = [
    ["server", /Still trying.*safe on this device.*server answered with an error/, /仍在重試.*伺服器上次回了錯誤/],
    ["connection", /Still trying.*safe on this device.*connection dropped/, /仍在重試.*連線中斷/],
    ["signin", /safe on this device.*signed out.*sign in again/, /還在這台裝置上.*已登出.*重新登入/],
  ] as const;
  for (const [reason, en, zh] of cases) {
    it(`says the last attempt failed (${reason}) in English and Chinese, without technical words`, async () => {
      open();
      await act(async () => { waiting(2); await refreshPendingCount(reason); });
      expect(text()).toMatch(en);
      expect(text()).not.toMatch(TECHNICAL);
      cleanup();
      setLocalePref("zh-TW");
      open();
      await act(async () => { waiting(2); await refreshPendingCount(reason); });
      expect(text()).toMatch(zh);
      expect(text()).not.toMatch(TECHNICAL);
    });
  }

  it("stays calm for a plain server hiccup (a waiting count, not an error) but a sign-out needs the person", async () => {
    open();
    await act(async () => { waiting(1); await refreshPendingCount("server"); });
    expect(screen.getByTestId("trouble").textContent).toMatch(/^pending:/);
    await act(async () => { await refreshPendingCount("signin"); });
    expect(screen.getByTestId("trouble").textContent).toMatch(/^error:1 change can't sync until you sign in again/);
  });

  it("goes away when sending works again", async () => {
    open();
    await act(async () => { waiting(1); await refreshPendingCount("connection"); });
    expect(text()).toMatch(/Still trying/);
    await act(async () => { await refreshPendingCount(null); });
    expect(text()).not.toMatch(/Still trying/);
  });

  it("classifies the failure in one place: signed out, server error, connection", () => {
    expect(sendFailureReason(new ApiError(401, "{}"))).toBe("signin");
    expect(sendFailureReason(new ApiError(500, "{}"))).toBe("server");
    expect(sendFailureReason(new TypeError("Failed to fetch"))).toBe("connection");
  });
});

describe("stuck: which note is first in line", () => {
  async function stick() {
    writes.list = [{ ...noteWrite, attempts: STUCK_AFTER_ATTEMPTS }, { ...noteWrite, id: 2 }];
    await act(async () => { await refreshPendingCount("server"); });
  }

  it("names the note (a link) and how long it has waited, in both languages", async () => {
    const openNote = vi.fn();
    open(openNote);
    await stick();
    expect(text()).toMatch(/2 changes stuck, oldest/);
    expect(text()).toMatch(/The oldest waiting change is in\s*Trip plan/);
    fireEvent.click(screen.getByRole("button", { name: "Trip plan" }));
    expect(openNote).toHaveBeenCalledWith("n1");
    expect(text()).not.toMatch(TECHNICAL);
    cleanup();
    setLocalePref("zh-TW");
    open(openNote);
    expect(text()).toMatch(/最早等著送出的修改在\s*Trip plan/);
    expect(text()).toMatch(/卡住了/);
    expect(text()).not.toMatch(/n1/);
  });

  it("shows 'Untitled' instead of an id when the note is not in the workspace", async () => {
    resetAppState({ data: { ...noWorkspaceData }, online: true });
    open(vi.fn());
    await stick();
    expect(screen.getByRole("button", { name: "Untitled" })).toBeTruthy();
    expect(text()).not.toMatch(/n1/);
  });
});

describe("receiving: the server's newer content is not arriving", () => {
  it("is not shown as plain 'Connected' (English and Chinese)", () => {
    open();
    expect(text()).toMatch(/Connected/);
    act(() => setIncomingProblem("unreachable"));
    expect(text()).not.toMatch(/Connected/);
    expect(text()).toMatch(/server isn't responding.*changes from other devices haven't arrived.*safe on this device/);
    expect(screen.getByTestId("trouble").textContent).toMatch(/^error:/);
    act(() => setIncomingProblem("refused"));
    expect(text()).toMatch(/couldn't send the latest changes/);
    expect(text()).not.toMatch(TECHNICAL);
    cleanup();
    setLocalePref("zh-TW");
    open();
    expect(text()).toMatch(/伺服器沒能送來最新內容/);
    act(() => setIncomingProblem("unreachable"));
    expect(text()).toMatch(/伺服器沒有回應，其他裝置的新內容還沒收到/);
    expect(text()).not.toMatch(TECHNICAL);
  });

  it("offers 'Sync now' and goes back to 'Connected' once a sync works", () => {
    open();
    act(() => setIncomingProblem("refused"));
    expect(screen.getByText("Sync now")).toBeTruthy();
    act(() => setIncomingProblem(null));
    expect(text()).toMatch(/Connected/);
    expect(screen.getByTestId("trouble").textContent).toBe("");
  });

  it("does not talk over the offline line", () => {
    resetAppState({ data: { ...noWorkspaceData }, online: false });
    open();
    act(() => setIncomingProblem("unreachable"));
    expect(text()).toMatch(/Offline — changes save locally/);
    expect(text()).not.toMatch(/server isn't responding/);
  });
});
