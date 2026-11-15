import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolbarLayoutEditor } from "../components/ToolbarLayoutEditor";
import SettingsModal from "../settings/SettingsModal";
import { resetAppState } from "../lib/appStore";
import { toolbarLayoutStore } from "../lib/toolbarLayoutStore";
import { parseToolbarLayout } from "../lib/toolbarLayout";

// Settings › 工具列: the switches, the order, 「恢復預設」, and that the choice
// is the account's (read from and written to the server's pref, not this
// browser). The server is a fake that keeps what it is sent.

let serverValue: unknown = null;
const sent: unknown[] = [];
vi.mock("../lib/data/onlineWrite", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/data/onlineWrite")>(),
  sendWrite: vi.fn(async (_method: string, path: string, body: { value: unknown }) => {
    sent.push({ path, value: body.value });
    serverValue = body.value;
    return { value: body.value };
  }),
}));
vi.mock("../lib/data/reads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/data/reads")>();
  return { ...real, reads: { ...real.reads, people: { ...real.reads.people, myPref: vi.fn(async () => ({ value: serverValue })) } } };
});
vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));

beforeEach(async () => {
  serverValue = null; sent.length = 0;
  localStorage.clear();
  resetAppState();
  toolbarLayoutStore.forget();
  await act(async () => { toolbarLayoutStore.save(null); await toolbarLayoutStore.sync(); });
  sent.length = 0;
});
afterEach(() => { cleanup(); toolbarLayoutStore.forget(); });

const section = (testId: string) => within(screen.getByTestId(testId));
const shownNames = (testId: string) =>
  section(testId).getAllByRole("list")[0]!.querySelectorAll("li[data-tool]").length
    ? Array.from(section(testId).getAllByRole("list")[0]!.querySelectorAll<HTMLElement>("li[data-tool]")).map((li) => li.dataset.tool)
    : [];
const moreNames = (testId: string) => {
  const lists = section(testId).queryAllByRole("list");
  return lists[1] ? Array.from(lists[1].querySelectorAll<HTMLElement>("li[data-tool]")).map((li) => li.dataset.tool) : [];
};

describe("Settings › 工具列", () => {
  it("lists both toolbars with every button, the default order, and nothing in 更多 on the phone bar", () => {
    render(<ToolbarLayoutEditor />);
    expect(screen.getByRole("heading", { name: "Phone and tablet format bar" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Selection toolbar" })).toBeTruthy();
    expect(shownNames("toolbar-bar").slice(0, 5)).toEqual(["tag", "copyLink", "ai", "toChild", "history"]);
    expect(shownNames("toolbar-bar")).not.toContain("paragraph");
    expect(moreNames("toolbar-bar")).toEqual([]);
    expect(shownNames("toolbar-selection")).toContain("toChild");
    expect(moreNames("toolbar-selection")).toEqual(["copyLink", "history", "convertTask", "expand"]);
  });

  it("a switch turns a button off: it moves to 更多 and the choice is sent to the account", async () => {
    render(<ToolbarLayoutEditor />);
    fireEvent.click(section("toolbar-bar").getByRole("switch", { name: "Show “Bold” in the toolbar" }));
    expect(shownNames("toolbar-bar")).not.toContain("bold");
    expect(moreNames("toolbar-bar")).toEqual(["bold"]);
    // The selection bar is its own list.
    expect(shownNames("toolbar-selection")).toContain("bold");
    await waitFor(() => expect(sent.at(-1)).toMatchObject({ path: "/api/me/prefs/toolbarLayout.desktop" }));
    const layout = parseToolbarLayout(serverValue)!;
    expect(layout.bar).not.toContain("bold");
    expect(layout.selection).toBeNull();
  });

  it("a button in 更多 comes back with its switch, at the end", () => {
    render(<ToolbarLayoutEditor />);
    fireEvent.click(section("toolbar-selection").getByRole("switch", { name: "Show “Copy block link” in the toolbar" }));
    expect(shownNames("toolbar-selection").at(-1)).toBe("copyLink");
    expect(moreNames("toolbar-selection")).not.toContain("copyLink");
  });

  it("the arrow keys on a handle reorder; the choice survives re-rendering from the store", () => {
    const { unmount } = render(<ToolbarLayoutEditor />);
    fireEvent.keyDown(section("toolbar-bar").getByRole("button", { name: "Reorder “Add tag”" }), { key: "ArrowDown" });
    expect(shownNames("toolbar-bar").slice(0, 2)).toEqual(["copyLink", "tag"]);
    unmount();
    render(<ToolbarLayoutEditor />);
    expect(shownNames("toolbar-bar").slice(0, 2)).toEqual(["copyLink", "tag"]);
  });

  it("上移 / 下移 appear on the row you tap, and move it", () => {
    render(<ToolbarLayoutEditor />);
    fireEvent.pointerDown(section("toolbar-bar").getByRole("button", { name: "Reorder “Link to a note”" }));
    fireEvent.pointerUp(section("toolbar-bar").getByRole("button", { name: "Reorder “Link to a note”" }));
    fireEvent.click(section("toolbar-bar").getByRole("button", { name: "Reorder “Link to a note”" }));
    fireEvent.click(section("toolbar-bar").getByRole("button", { name: "Move “Link to a note” up" }));
    expect(shownNames("toolbar-bar").slice(5, 8)).toEqual(["convertTask", "wikilink", "expand"]);
  });

  it("「恢復預設」 is disabled until a toolbar was edited, then restores only that toolbar", async () => {
    render(<ToolbarLayoutEditor />);
    const reset = (id: string) => section(id).getByRole("button", { name: "Reset" }) as HTMLButtonElement;
    expect(reset("toolbar-bar").disabled).toBe(true);
    fireEvent.click(section("toolbar-bar").getByRole("switch", { name: "Show “Bold” in the toolbar" }));
    fireEvent.click(section("toolbar-selection").getByRole("switch", { name: "Show “Bold” in the toolbar" }));
    expect(reset("toolbar-bar").disabled).toBe(false);
    fireEvent.click(reset("toolbar-bar"));
    expect(shownNames("toolbar-bar")).toContain("bold");
    expect(shownNames("toolbar-selection")).not.toContain("bold");
    fireEvent.click(reset("toolbar-selection"));
    await waitFor(() => expect(serverValue).toBeNull());
  });

  it("reads the account's layout from the server on another device", async () => {
    serverValue = { bar: ["bold", "quote"], selection: null };
    await act(async () => { toolbarLayoutStore.forget(); await toolbarLayoutStore.sync(); });
    render(<ToolbarLayoutEditor />);
    expect(shownNames("toolbar-bar")).toEqual(["bold", "quote"]);
    expect(moreNames("toolbar-bar")).toContain("copyLink");
  });

  it("the toolbars' 「編輯工具列…」 opens Settings › Notes with the editor already unfolded", async () => {
    const { openToolbarEditor, takeToolbarEditorRequest } = await import("../lib/toolbarEditorRequest");
    openToolbarEditor();
    expect(takeToolbarEditorRequest()).toBe(true);
    expect(takeToolbarEditorRequest()).toBe(false);
    openToolbarEditor();
    render(<SettingsModal online onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} initialTab="notes" />);
    expect(await screen.findByTestId("toolbar-settings")).toBeTruthy();
  });
});

describe("finding it in Settings", () => {
  it("the search finds it by 工具列 or toolbar, and it is an account setting next to the navigation bar", async () => {
    const user = userEvent.setup();
    render(<SettingsModal online onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Notes/ })).toBeTruthy();
    for (const query of ["toolbar", "工具列", "format bar"]) {
      await user.clear(screen.getByRole("searchbox", { name: "Search settings…" }));
      await user.type(screen.getByRole("searchbox", { name: "Search settings…" }), query);
      // The result is the setting itself: folded until asked for, then both toolbars' editors.
      expect(screen.getByRole("button", { name: "Edit the toolbar…" })).toBeTruthy();
    }
    await user.click(screen.getByRole("button", { name: "Edit the toolbar…" }));
    expect(screen.getByTestId("toolbar-settings")).toBeTruthy();
  });

  it("the toolbars' 「編輯工具列…」 opens Settings › Notes with the editor already unfolded", async () => {
    const { openToolbarEditor, takeToolbarEditorRequest } = await import("../lib/toolbarEditorRequest");
    openToolbarEditor();
    expect(takeToolbarEditorRequest()).toBe(true);
    expect(takeToolbarEditorRequest()).toBe(false);
    openToolbarEditor();
    render(<SettingsModal online onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} initialTab="notes" />);
    expect(await screen.findByTestId("toolbar-settings")).toBeTruthy();
  });
});
