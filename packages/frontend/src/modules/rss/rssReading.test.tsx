import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { lazy } from "react";
import { BookOpen } from "lucide-react";

// New RSS articles are not something to approve, so they are not in the
// inbox: they wait in Reading (the RSS reader). By default nothing is
// counted: 閱讀 shows a dot when something new arrived. 「顯示未讀數字」
// turns the numbers on (All feeds, each feed, the tab), and a feed's own
// choice overrides it. 「全部略過」 marks the open view seen.

const { apiMock, sendWriteMock } = vi.hoisted(() => ({ apiMock: vi.fn(), sendWriteMock: vi.fn(async () => ({})) }));
vi.mock("../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api")>();
  return { ...mod, api: apiMock };
});
vi.mock("../../lib/data", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/data")>();
  return { ...mod, sendWrite: sendWriteMock };
});

import ReadingScreen from "../../components/ReadingScreen";
import type { ModuleScreenProps, ReadingSection } from "../types";
import { rssModule } from ".";
import { forgetRssPrefs } from "./rssPrefs";
import RssReaderPanel from "./RssReaderPanel";
import type { RssSource } from "./useRssUnread";
import { setFeedCountChoice } from "./rssCounts";
import { rssShowCountsPref } from "./rssPrefs";
import { bindAccountStorage } from "../../lib/accountStorage";

bindAccountStorage("unit-test-account", "");

const src = (id: string, title: string, unseen: number): RssSource => ({
  id, title, url: null, fetch_interval_minutes: 60, last_fetched_at: null,
  last_error: null, auto_tag: null, embed: false, unseen, created_at: new Date().toISOString(),
});
let sources: RssSource[] = [];
beforeEach(() => {
  localStorage.clear();
  forgetRssPrefs();
  apiMock.mockReset();
  sendWriteMock.mockClear();
  apiMock.mockImplementation(async (path: string) => path.startsWith("/api/rss/sources")
    ? { sources, total_unseen: sources.reduce((n, s) => n + s.unseen, 0), latest_unseen_at: sources.some((s) => s.unseen > 0) ? "2026-10-18T00:00:00.000Z" : null }
    : { items: [] });
});

const stub = (id: string, label: string): ReadingSection => ({
  id, label, Icon: BookOpen, order: 0,
  Component: lazy(async () => ({ default: (_: ModuleScreenProps) => <p>{label} body</p> })),
});
const screenProps = { online: true, target: null, onOpenNode: vi.fn(), onRefresh: vi.fn(), onImmersiveChange: vi.fn() };

/** The 「全部」 tag in the source row (the list tools have an All too). */
const allTag = () => within(screen.getByRole("toolbar", { name: "Feeds" })).getAllByRole("button")[0]!;

describe("RSS lives in Reading, not the inbox", () => {
  it("the module has no inbox section; its reading tab and nav entries carry its mark", () => {
    expect(rssModule).not.toHaveProperty("InboxSection");
    expect(rssModule.readingSections?.find((s) => s.id === "rss")?.Badge).toBeTruthy();
    expect(rssModule.NavIndicator).toBeTruthy();
  });

  it("the RSS tab shows a dot for new articles by default, a number with 「顯示未讀數字」, and nothing at zero", async () => {
    sources = [src("a", "A Feed", 8), src("b", "B Feed", 3)];
    const rss = { ...rssModule.readingSections!.find((s) => s.id === "rss")!, Component: stub("rss", "RSS").Component };
    const view = () => render(<ReadingScreen activeId="other" onSelect={vi.fn()} {...screenProps}
      sections={[rss, stub("other", "Other")]} />);
    let r = view();
    let nav = screen.getByRole("navigation", { name: "Reading sections" });
    expect(await within(nav).findByRole("img", { name: "New articles" })).toBeInTheDocument();
    expect(within(nav).queryByText("11")).toBeNull();
    r.unmount();

    rssShowCountsPref.store.save(true);
    r = view();
    nav = screen.getByRole("navigation", { name: "Reading sections" });
    expect(await within(nav).findByText("11")).toBeInTheDocument();
    expect(within(nav).getByLabelText("11 new articles")).toBeInTheDocument();
    r.unmount();

    sources = [src("a", "A Feed", 0)];
    view();
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(document.querySelector(".nav-indicator")).toBeNull();
  });

  it("the reader shows feed numbers only with the setting on (a feed can differ), and the picked tag is pressed", async () => {
    sources = [src("a", "A Feed", 8), src("b", "B Feed", 3)];
    const r = render(<RssReaderPanel online onClose={() => {}} onOpenNode={() => {}} onRefresh={() => {}} />);
    const rowA = (await screen.findByText("A Feed")).closest("button")!;
    expect(within(rowA).queryByText("8")).toBeNull();
    expect(allTag().querySelector(".ui-filter-chip__count")).toBeNull();
    r.unmount();

    rssShowCountsPref.store.save(true);
    setFeedCountChoice("b", "off");
    render(<RssReaderPanel online onClose={() => {}} onOpenNode={() => {}} onRefresh={() => {}} />);
    const row = (await screen.findByText("A Feed")).closest("button")!;
    expect(await within(row).findByText("8")).toBeInTheDocument();
    expect(screen.getByText("B Feed").closest("button")!.querySelector(".ui-filter-chip__count")).toBeNull();
    // All feeds adds up the feeds whose number is shown.
    expect(within(allTag()).getByText("8")).toBeInTheDocument();
    fireEvent.click(row);
    await waitFor(() => expect(row).toHaveAttribute("aria-pressed", "true"));
  });

  it("a feed set to show its number shows it with the setting off", async () => {
    sources = [src("a", "A Feed", 8), src("b", "B Feed", 3)];
    setFeedCountChoice("a", "on");
    render(<RssReaderPanel online onClose={() => {}} onOpenNode={() => {}} onRefresh={() => {}} />);
    const rowA = (await screen.findByText("A Feed")).closest("button")!;
    expect(await within(rowA).findByText("8")).toBeInTheDocument();
    expect(screen.getByText("B Feed").closest("button")!.querySelector(".ui-filter-chip__count")).toBeNull();
    expect(allTag().querySelector(".ui-filter-chip__count")).toBeNull();
  });
});
