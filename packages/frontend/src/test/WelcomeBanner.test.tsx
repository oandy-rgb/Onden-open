import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import WelcomeBanner from "../components/WelcomeBanner";

// First-run welcome card. These cover the contract the host (BuilderApp) relies
// on: the three first-flow actions wire to the right handlers, the opt-in
// starter install is gated + confirms, and offline disables the install. The
// SHOW/HIDE gating (welcomeDismissed flag, returning users) lives in the host
// and is asserted via the dismiss handler being the persisted toggle.

function setup(overrides: Partial<React.ComponentProps<typeof WelcomeBanner>> = {}) {
  const props = {
    onCreateNote: vi.fn(),
    onOpenToday: vi.fn(),
    onInstallStarter: vi.fn().mockResolvedValue(true),
    onBuildSite: vi.fn().mockResolvedValue("/site/home"),
    onDismiss: vi.fn(),
    online: true,
    ...overrides,
  };
  render(<WelcomeBanner {...props} />);
  return props;
}

describe("WelcomeBanner (first-run, land-in-a-flow)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the calm welcome with the core-loop pitch", () => {
    setup();
    expect(screen.getByText("Welcome to Onden")).toBeTruthy();
    expect(screen.getByText(/Capture a thought/)).toBeTruthy();
  });

  it("'Write your first note' lands the user in the editor (capture rail)", () => {
    const { onCreateNote } = setup();
    fireEvent.click(screen.getByText("Write your first note"));
    expect(onCreateNote).toHaveBeenCalledTimes(1);
  });

  it("'Open today's note' wires to the daily-note flow", () => {
    const { onOpenToday } = setup();
    fireEvent.click(screen.getByText("Open today's note"));
    expect(onOpenToday).toHaveBeenCalledTimes(1);
  });

  it("starter install is opt-in: only fires on click, then confirms", async () => {
    const onInstallStarter = vi.fn().mockResolvedValue(true);
    setup({ onInstallStarter });
    // Not called until the user clicks — nothing is silently seeded.
    expect(onInstallStarter).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Add a starter tag/));
    expect(onInstallStarter).toHaveBeenCalledTimes(1);
    // Passes a real pack payload + label (the host posts it to /api/tags/import).
    expect(onInstallStarter.mock.calls[0][0]).toBeTruthy();
    expect(typeof onInstallStarter.mock.calls[0][1]).toBe("string");
    await waitFor(() => expect(screen.getByText("Added a starter tag")).toBeTruthy());
    // Removable + non-clobbering messaging surfaces after install.
    expect(screen.getByText(/delete the tag any time/)).toBeTruthy();
  });

  it("a failed install does not show the success confirmation", async () => {
    const onInstallStarter = vi.fn().mockResolvedValue(false);
    setup({ onInstallStarter });
    fireEvent.click(screen.getByText(/Add a starter tag/));
    await waitFor(() => expect(onInstallStarter).toHaveBeenCalled());
    expect(screen.queryByText("Added a starter tag")).toBeNull();
  });

  it("disables the starter install when offline (the route needs the API)", () => {
    setup({ online: false });
    const btn = screen.getByText(/Add a starter tag/).closest("button")!;
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("'Build your first website' is opt-in: fires on click, then surfaces the live site link", async () => {
    const onBuildSite = vi.fn().mockResolvedValue("/site/home");
    setup({ onBuildSite });
    expect(onBuildSite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Build your first website"));
    expect(onBuildSite).toHaveBeenCalledTimes(1);
    // On success the card confirms AND links to the published site.
    await waitFor(() => expect(screen.getByText("Your site is live")).toBeTruthy());
    const link = screen.getByText("View your published site →").closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/site/home");
  });

  it("a failed site build shows no live-site link", async () => {
    const onBuildSite = vi.fn().mockResolvedValue(null);
    setup({ onBuildSite });
    fireEvent.click(screen.getByText("Build your first website"));
    await waitFor(() => expect(onBuildSite).toHaveBeenCalled());
    expect(screen.queryByText("View your published site →")).toBeNull();
  });

  it("disables the site build when offline (publish needs the API)", () => {
    setup({ online: false });
    const btn = screen.getByText("Build your first website").closest("button")!;
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("dismiss calls the persisted toggle (host gates returning users on it)", () => {
    const { onDismiss } = setup();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("WelcomeBanner interface language", () => {
  it("offers 繁體中文 and English, starts on the browser's language, and picking switches the card", async () => {
    const { getLocale, setLocalePref } = await import("../lib/i18n");
    setLocalePref("system");
    setup();
    const group = screen.getByRole("radiogroup", { name: "Interface language" });
    const [zh, en] = ["繁體中文", "English"].map((name) => screen.getByRole("radio", { name }));
    expect(group).toBeTruthy();
    expect(getLocale() === "en" ? en : zh).toHaveAttribute("aria-checked", "true");
    fireEvent.click(zh!);
    expect(getLocale()).toBe("zh-TW");
    expect(screen.getByRole("radio", { name: "繁體中文" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    expect(getLocale()).toBe("en");
    setLocalePref("system");
  });
});

describe("WelcomeBanner languageOnly (browser app first open)", () => {
  it("shows the language choice without the first-note buttons", () => {
    setup({ languageOnly: true });
    expect(screen.getByRole("radiogroup", { name: "Interface language" })).toBeTruthy();
    expect(screen.queryByText("Write your first note")).toBeNull();
  });
});
