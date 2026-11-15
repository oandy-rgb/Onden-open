// Settings › 快速記錄 › 「快速記錄放哪裡」: the account's one default for a capture.
// The inbox is the default; today's journal is offered only while the journal is
// on; a note is chosen with the place picker. A choice that stops working (the
// journal turned off, the note gone) reads as the inbox without losing the choice.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async () => ({ status: "queued" }),
}));

import "../modules";
import CaptureDestinationSetting from "../modules/capture/CaptureDestinationSetting";
import { captureDestinationPref } from "../modules/capture/captureDestination";
import { BUILT_IN_SETTINGS, MODULE_SETTINGS } from "../modules";
import { TABS } from "../settings/registry";
import { bindAccountStorage } from "../lib/accountStorage";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState, setData } from "../lib/appStore";

const note = (id: string, title: string, extra: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title, slug: id, markdown: "", source_type: "manual", node_type: "content", ...extra });

const world = (modules: string[] | null, nodes: ContentNode[] = [note("n-reading", "Reading list")]) =>
  act(() => setData(() => ({ ...noWorkspaceData, nodes, workspace: { ...noWorkspaceData.workspace, modules } })));
const ctx = { online: true, onClose: () => {}, onImportDone: () => {}, onConnect: () => {} };
const renderSetting = () => render(<CaptureDestinationSetting ctx={ctx} />);

beforeAll(() => { bindAccountStorage("settings-user", "https://onden.example/"); });
beforeEach(() => {
  resetAppState();
  localStorage.clear();
  captureDestinationPref.store.save(null);
});

describe("where captures go (setting)", () => {
  it("is listed once, on the Settings page 快速記錄 (it cannot be turned off, so it is not a feature page)", () => {
    expect(MODULE_SETTINGS.filter((s) => s.id === "capture.destination")).toHaveLength(0);
    const rows = BUILT_IN_SETTINGS.filter((s) => s.id === "capture.destination");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tab: "capture", type: "custom" });
    expect(TABS.find((tab) => tab.id === "capture")?.label).toBe("Quick capture");
  });

  it("starts at the inbox", async () => {
    await world(null);
    renderSetting();
    expect(screen.getByText("Captures go to: Inbox")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use the inbox" })).toBeNull();
  });

  it("chooses today's journal while the journal is on", async () => {
    await world(["daily"]);
    renderSetting();
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    await userEvent.click(screen.getByRole("button", { name: "Today's journal" }));
    expect(captureDestinationPref.store.get().value).toBe("today");
    expect(screen.getByText("Captures go to: Today's journal")).toBeInTheDocument();
  });

  it("does not offer today's journal while the journal is off", async () => {
    await world(["canvas"]);
    renderSetting();
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    expect(screen.queryByRole("button", { name: "Today's journal" })).toBeNull();
  });

  it("falls back to the inbox, and says so, when the journal is turned off after choosing it", async () => {
    await world(["daily"]);
    captureDestinationPref.store.save("today");
    const view = renderSetting();
    expect(screen.getByText("Captures go to: Today's journal")).toBeInTheDocument();
    await world(["canvas"]);
    view.rerender(<CaptureDestinationSetting ctx={ctx} />);
    expect(screen.getByText("Captures go to: Inbox")).toBeInTheDocument();
    expect(screen.getByText("The place you chose is not available now, so captures go to the inbox.")).toBeInTheDocument();
    // The choice itself is kept for when the journal comes back.
    expect(captureDestinationPref.store.get().value).toBe("today");
  });

  it("chooses one note, and goes back to the inbox with one click", async () => {
    await world(null);
    renderSetting();
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    await userEvent.click(await screen.findByRole("option", { name: /Reading list/ }));
    expect(captureDestinationPref.store.get().value).toBe("n-reading");
    expect(screen.getByText("Captures go to: Reading list")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use the inbox" }));
    expect(captureDestinationPref.store.get().value).toBe("inbox");
    expect(screen.getByText("Captures go to: Inbox")).toBeInTheDocument();
  });

  it("a chosen note that is gone reads as the inbox", async () => {
    await world(null, []);
    captureDestinationPref.store.save("n-gone");
    renderSetting();
    expect(screen.getByText("Captures go to: Inbox")).toBeInTheDocument();
  });
});
