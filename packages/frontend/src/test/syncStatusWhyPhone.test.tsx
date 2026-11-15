// On a phone-width layout the same details are reachable: the strip above the
// bottom bar (MobileNav) and the account sheet opened from the avatar
// (AppTopbar). The layout is emulated, not a real device.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const writes = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => writes.list),
  getOldestPendingWriteAt: vi.fn(async () => "2026-11-12 08:00:00"),
}));
vi.mock("../lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "u1", name: "Andy", email: "a@example.com" } } }), signOut: vi.fn() },
}));
vi.mock("../lib/accountStorage", async (original) => ({ ...await original<typeof import("../lib/accountStorage")>(), boundAccountId: () => "u1" }));

import AppTopbar from "../components/AppTopbar";
import MobileNav from "../components/MobileNav";
import { resetAppState } from "../lib/appStore";
import { noWorkspaceData } from "../lib/api";
import { setLocalePref } from "../lib/i18n";
import { refreshPendingCount, STUCK_AFTER_ATTEMPTS } from "../lib/data/syncStatus";
import { setIncomingProblem } from "../lib/data/incomingStatus";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";

const note = { id: "n1", title: "Trip plan", markdown: "", source_type: "manual" as const, node_type: "content" as const, slug: "n1" };
const stuckQueue = () => [{ id: 1, method: "PATCH", path: "/api/nodes/n1", body: "{}", idem_key: "k", attempts: STUCK_AFTER_ATTEMPTS }];

beforeEach(async () => {
  setPhoneLayout(true); setLocalePref("en");
  resetAppState({ data: { ...noWorkspaceData, nodes: [note] }, online: true });
  writes.list = []; setIncomingProblem(null);
  await refreshPendingCount(null);
});
afterEach(async () => { cleanup(); clearPhoneLayout(); setLocalePref("system"); setIncomingProblem(null); writes.list = []; await refreshPendingCount(null); });

describe("sync details at phone width", () => {
  it("the strip above the bottom bar names the note that is stuck and opens it", async () => {
    const onOpenNote = vi.fn();
    render(<MobileNav mode="notes" setMode={vi.fn()} onCapture={vi.fn()} onOpenFeature={vi.fn()} onOpenNote={onOpenNote} />);
    writes.list = stuckQueue();
    await act(async () => { await refreshPendingCount("connection"); });
    expect(document.body.textContent).toMatch(/1 change stuck/);
    fireEvent.click(screen.getByRole("button", { name: "Trip plan" }));
    expect(onOpenNote).toHaveBeenCalledWith("n1");
  });

  it("the strip appears when only the server's newer content is not arriving", () => {
    render(<MobileNav mode="notes" setMode={vi.fn()} onCapture={vi.fn()} onOpenFeature={vi.fn()} />);
    expect(document.body.textContent).not.toMatch(/Connected/);
    act(() => setIncomingProblem("refused"));
    expect(document.body.textContent).toMatch(/couldn't send the latest changes/);
  });

  it("the avatar's sheet shows the reason and the note", async () => {
    render(<AppTopbar mode="notes" setMode={vi.fn()} onOpenModule={vi.fn()} onOpenFeature={vi.fn()} onOpenPalette={vi.fn()}
      onOpenMembers={vi.fn()} onOpenSettings={vi.fn()} onSyncNow={vi.fn()} onOpenNote={vi.fn()} />);
    writes.list = stuckQueue();
    await act(async () => { await refreshPendingCount("server"); });
    fireEvent.click(screen.getByRole("button", { name: /Andy/ }));
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText(/server keeps answering with an error/)).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Trip plan" })).toBeTruthy();
  });
});
