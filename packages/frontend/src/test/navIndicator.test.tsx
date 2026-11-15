import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

// A module's nav mark (FrontendModule.NavIndicator — RSS: a dot when articles
// arrived since the reader was last open) is carried once by the nav model
// (useImportedFeatures → shellNavigation) to every surface: the desktop
// entry, the 更多 ▾ menu (and 更多 ▾ itself when the entry is folded), the
// phone's 更多 button and its sheet row. 閱讀 never returns to the phone bar.

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: apiMock };
});
vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));

import { AppNavigation } from "../components/AppTopbar";
import MobileNav from "../components/MobileNav";
import { resetAppState } from "../lib/appStore";
import { noWorkspaceData } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { usedFixture } from "./helpers/moduleUse";

bindAccountStorage("unit-test-account", "");

let latest: string | null = "2026-10-18T08:00:00.000Z";
beforeEach(() => {
  localStorage.clear();
  latest = "2026-10-18T08:00:00.000Z";
  resetAppState({ data: { ...noWorkspaceData, ...usedFixture(["review", "rss", "website", "canvas"]), workspace: { ...noWorkspaceData.workspace, modules: ["tasks", "review", "rss", "website", "canvas"] }, actor_is_owner: false } });
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => path.startsWith("/api/rss/sources")
    ? { sources: [{ id: "feed-1", title: "Feed", url: "https://example.com/feed.xml" }], total_unseen: latest ? 3 : 0, latest_unseen_at: latest, module_default: null }
    : {});
});
afterEach(() => vi.restoreAllMocks());

const navProps = () => ({ mode: "notes" as const, setMode: vi.fn(), onOpenModule: vi.fn(), onOpenFeature: vi.fn() });
const mobileProps = () => ({
  mode: "notes" as const, setMode: vi.fn(), onCapture: vi.fn(), onOpenFeature: vi.fn(),
  onOpenTag: vi.fn(),
});
const dot = (el: HTMLElement) => within(el).queryByRole("img", { name: "New articles" });

describe("the nav dot, carried by the nav model", () => {
  it("desktop: on the 閱讀 entry only", async () => {
    render(<AppNavigation {...navProps()} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const reading = within(nav).getByRole("button", { name: /Reading/ });
    expect(await within(reading).findByRole("img", { name: "New articles" })).toBeInTheDocument();
    for (const name of ["Notes", "Review", "Website"]) expect(dot(within(nav).getByRole("button", { name: new RegExp(name) }))).toBeNull();
  });

  it("desktop: a folded 閱讀 lights 更多 ▾ with one dot, and keeps its own in the menu", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("app-topbar-left") ? 700 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("app-logo")) return 100;
      return this.dataset.measure ? 110 : 0;
    });
    render(<div className="app-topbar-left"><span className="app-logo">Onden</span><AppNavigation {...navProps()} /></div>);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const more = within(nav).getByRole("button", { name: /More/ });
    expect(await within(more).findByRole("img", { name: "New articles" })).toBeInTheDocument();
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "More" });
    expect(dot(within(menu).getByRole("menuitem", { name: /Reading/ }))).not.toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /Canvas/ })).toBeNull();
  });

  it("phone: a dot on 更多 and on the RSS row inside; 閱讀 stays out of the bar", async () => {
    render(<MobileNav {...mobileProps()} />);
    const bar = screen.getByRole("navigation", { name: "Primary" });
    expect(within(bar).queryByText("Reading")).toBeNull();
    const more = within(bar).getByRole("button", { name: "More" });
    expect(await within(more).findByRole("img", { name: "New articles" })).toBeInTheDocument();
    fireEvent.click(more);
    const sheet = screen.getByRole("dialog", { name: "More" });
    const row = sheet.querySelector<HTMLElement>('[data-entry="reading"]')!;
    expect(dot(row)).not.toBeNull();
    expect(dot(sheet.querySelector<HTMLElement>('[data-entry="review"]')!)).toBeNull();
  });

  it("nothing new, no dot anywhere", async () => {
    latest = null;
    render(<MobileNav {...mobileProps()} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock).toHaveBeenCalled();
    expect(document.querySelector(".nav-indicator")).toBeNull();
  });
});
