import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import OverviewSidebar from "../components/OverviewSidebar";
import { DecisionsProvider } from "../hooks/DecisionsContext";
import { resetAppState, getAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { sidebarGroups } from "./fixtures/sidebarGroups";
import { ownerData } from "./ownerData";
import type { ContentNode, Tag } from "../lib/api";

// The inbox is a tab beside 筆記: the phone's third (標籤 | 筆記 | 收件匣), the
// desktop sidebar's second (筆記 | 收件匣). It is no longer a nav destination.

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: apiMock }));
vi.mock("../lib/localDb", () => ({ searchNodes: vi.fn(async () => []) }));
const filter = vi.hoisted(() => ({ inboxOff: false }));
vi.mock("../modules", async (original) => {
  const real = await original<typeof import("../modules")>();
  return { ...real, get INBOX_PAGE() { return filter.inboxOff ? null : real.INBOX_PAGE; } };
});

const INBOX_TAG = { id: "t-inbox", name: "收件匣", color: "", schema_id: "t-inbox", schema_module: "capture" } as unknown as Tag;
const capture = (id: string, title: string): ContentNode => ({
  id, title, slug: id, markdown: title, node_type: "content", source_type: "manual", label_tag_ids: ["t-inbox"],
} as ContentNode);

function phone(matches: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: matches && query.includes("max-width: 900px"), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}
const originalMatchMedia = window.matchMedia;
const tabs = () => [...document.querySelectorAll(".sidebar-tab")].map((el) => el.textContent?.trim());
const inbox = { events: [], busyId: null, onApprove: vi.fn(), onReject: vi.fn() };
const renderSidebar = () => render(<DecisionsProvider inbox={inbox}><OverviewSidebar {...sidebarGroups()} /></DecisionsProvider>);

beforeEach(() => {
  localStorage.clear();
  bindAccountStorage("unit-test-account", "");
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/inbox/failed-effects")) return { failed: [], count: 0, groups: [], total: 0 };
    if (path.startsWith("/api/rss/sources")) return { sources: [], total_unseen: 0 };
    if (path.startsWith("/api/events")) return { events: [] };
    return {};
  });
  filter.inboxOff = false;
  resetAppState({ data: { ...ownerData, nodes: [capture("c1", "Buy milk"), capture("c2", "Call Sam")], tags: [INBOX_TAG] }, online: true });
  phone(true);
});
afterEach(() => { window.matchMedia = originalMatchMedia; resetAppState(); localStorage.clear(); });

describe("phone Notes home: 標籤 | 筆記 | 收件匣", () => {
  it("has the inbox as the third tab, with the waiting count", () => {
    renderSidebar();
    expect(tabs()).toEqual(["Tags", "Notes", "Inbox2"]);
  });

  it("shows no number when nothing waits", () => {
    resetAppState({ data: { ...ownerData, nodes: [], tags: [INBOX_TAG] }, online: true });
    renderSidebar();
    expect(tabs()).toEqual(["Tags", "Notes", "Inbox"]);
  });

  it("the inbox tab shows the inbox page itself, 「等你決定」 section and the captures", async () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
    expect(getAppState().overviewPane).toBe("inbox");
    // The tab names it: the page leaves out its own title.
    expect(await screen.findByRole("region", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Inbox" })).toBeNull();
    expect(await screen.findByText("Buy milk")).toBeInTheDocument();
    // The page list is the inbox, not the notes tree.
    expect(document.querySelector(".sb-tagtree")).toBeNull();
  });

  it("remembers the inbox tab on this device", async () => {
    const first = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
    first.unmount();
    resetAppState({ data: { ...ownerData, nodes: [], tags: [INBOX_TAG] }, online: true });
    renderSidebar();
    await waitFor(() => expect(document.querySelector(".sidebar-tab.active")?.textContent).toMatch(/^Inbox/));
  });

  it("without the capture module there is no inbox tab, and a remembered inbox tab falls back to 筆記", () => {
    filter.inboxOff = true;
    localStorage.setItem("onden.sidebar.pane", "inbox");
    renderSidebar();
    expect(tabs()).toEqual(["Tags", "Notes"]);
    expect(document.querySelector(".sidebar-tab.active")?.textContent).toBe("Notes");
  });
});

describe("desktop sidebar", () => {
  beforeEach(() => phone(false));

  it("has the inbox as a tab beside 筆記, with the count, showing the inbox in the sidebar", async () => {
    renderSidebar();
    expect(tabs()).toEqual(["Notes", "Inbox2"]);
    expect(document.querySelector(".sb-inbox-row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
    expect(getAppState().overviewPane).toBe("inbox");
    expect(await screen.findByRole("region", { name: "Inbox" })).toBeInTheDocument();
    expect(await screen.findByText("Buy milk")).toBeInTheDocument();
  });

  it("has no inbox tab without the capture module", () => {
    filter.inboxOff = true;
    renderSidebar();
    expect(tabs()).toEqual(["Notes"]);
  });
});
