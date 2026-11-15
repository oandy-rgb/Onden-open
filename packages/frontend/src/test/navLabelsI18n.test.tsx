import { describe, it, expect, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ViewTabs } from "../components/viewTabs";
import { AppNavigation } from "../components/AppTopbar";
import HomeStart from "../components/HomeStart";
import { setLocalePref } from "../lib/i18n";
import { type ContentNode } from "../lib/api";
import { ownerData } from "./ownerData";
import { resetAppState } from "../lib/appStore";
import { usedFixture } from "./helpers/moduleUse";

// Regression: lens/place nav labels + HomeStart chrome must run through t(),
// so switching to zh-TW does not leave the chrome stranded in English.

afterEach(() => {
  act(() => setLocalePref("system")); // jsdom navigator.language = en-US
});

describe("nav labels are i18n-wired (ViewTabs + HomeStart)", () => {
  it("note views and primary navigation translate under zh-TW", () => {
    act(() => setLocalePref("zh-TW"));
    // A feed is subscribed, so Reading is in the nav (it lists functions in use).
    act(() => resetAppState({ data: { ...ownerData, ...usedFixture(["rss"]) } }));
    render(
      <><ViewTabs owner={{ kind: "node", id: "n1", name: "N" }} activeKey="content" earnsWhiteboard={false} canManage={false} fields={[]} onSelect={() => {}} />
        <AppNavigation mode="notes" setMode={() => {}} onOpenModule={() => {}} onOpenFeature={() => {}} /></>,
    );
    expect(screen.getByText("內容")).toBeTruthy();
    // 歷史 is no note view; the workspace history page sits in 更多 ▾.
    expect(screen.queryByText("歷史")).toBeNull();
    expect(screen.queryByText("Content")).toBeNull();
    expect(screen.queryByText("Editor")).toBeNull();
    // Workspace destinations are distinct from the current note views.
    expect(screen.getByText("閱讀")).toBeTruthy();
    expect(screen.queryByText("Reading")).toBeNull();
    expect(screen.queryByText("Subscriptions")).toBeNull();
  });

  it("the rest of the top bar translates under zh-TW", () => {
    act(() => setLocalePref("zh-TW"));
    render(
      <><ViewTabs owner={{ kind: "node", id: "n1", name: "N" }} activeKey="content" earnsWhiteboard={false} canManage={false} fields={[]} onSelect={() => {}} />
        <AppNavigation mode="notes" setMode={() => {}} onOpenModule={() => {}} onOpenFeature={() => {}} /></>,
    );
    expect(screen.getByText("任務")).toBeTruthy();   // Tasks
    expect(screen.getByText("關係圖")).toBeTruthy(); // Graph
    expect(screen.queryByText("標籤")).toBeNull();   // Tags is no destination
    expect(screen.getByText("更多")).toBeTruthy();   // 更多 ▾ holds the workspace changes page
  });

  it("English locale keeps the literal labels (identity)", () => {
    act(() => setLocalePref("en"));
    render(
      <><ViewTabs owner={{ kind: "node", id: "n1", name: "N" }} activeKey="content" earnsWhiteboard={false} canManage={false} fields={[]} onSelect={() => {}} />
        <AppNavigation mode="notes" setMode={() => {}} onOpenModule={() => {}} onOpenFeature={() => {}} /></>,
    );
    expect(screen.getByText("Content")).toBeTruthy();
    expect(screen.queryByText("內容")).toBeNull();
    expect(screen.getByText("Graph")).toBeTruthy();
  });

  it("HomeStart chrome (today / Recent / Loose ends) translates under zh-TW", () => {
    act(() => setLocalePref("zh-TW"));
    const node = (id: string): ContentNode => ({
      id, title: `Note ${id}`, slug: id, markdown: "", source_type: "manual",
      node_type: "content", updated_at: "2026-06-02T00:00:00Z",
    });
    render(
      <HomeStart
        homeNodeId="home"
        nodes={[node("a")]}
        tasks={[{ id: "t1", node_id: "a", title: "Do thing", status: "todo" } as never]}
        pinnedTags={[]}
        onOpenNode={() => {}}
        onOpenToday={() => {}}
        onOpenTagView={() => {}}
      />,
    );
    expect(screen.getByText("開啟今日筆記")).toBeTruthy(); // Open today's note
    expect(screen.getByText("最近")).toBeTruthy();         // Recent
    expect(screen.getByText("未竟事項")).toBeTruthy();     // Loose ends
    expect(screen.queryByText("Recent")).toBeNull();
    expect(screen.queryByText("Loose ends")).toBeNull();
  });
});
