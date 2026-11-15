// The row of view tabs above a note or a tag (components/viewTabs/ViewTabs):
// 「內容」 first, the page's views, 「＋」; rename, delete, move; the whiteboard
// tab; what 「＋」 offers and says.
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ViewTabs } from "../components/viewTabs";
import { reads } from "../lib/data";
import { resetAppState, setAppState } from "../lib/appStore";
import { resetOwnerViews } from "../lib/ownerViews";
import { takeViewSettingsRequest } from "../lib/viewSettingsRequest";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";
import { SplitDropHint } from "../components/splitView";
import { onSplitDrop, splitDrag } from "../lib/splitViewStore";

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));

const writes = vi.hoisted(() => ({ create: vi.fn(async () => "new-id" as string | null), update: vi.fn(async () => ({ status: "ok" })), remove: vi.fn(async () => {}) }));
vi.mock("../lib/data/domainWriters", async (load) => {
  const actual = await load<typeof import("../lib/data/domainWriters")>();
  return { ...actual, viewWriter: { create: writes.create, update: writes.update, remove: writes.remove } };
});
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../components/ConfirmDialog", async (load) => ({ ...await load<typeof import("../components/ConfirmDialog")>(), confirmDialog: confirm }));

const NODE = "00000000-0000-4000-8000-00000000a001";
const reply = vi.hoisted(() => ({ views: [] as unknown[] }));
vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return { ...actual, api: vi.fn(async (path: string) => {
    if (path === `/api/nodes/${NODE}/views`) return { views: reply.views };
    throw new Error(`unexpected ${path}`);
  }) };
});

const saved = (id: string, name: string, layout: string, extra: Record<string, unknown> = {}) =>
  ({ id, node_id: NODE, name, layout, filters: [], sorts: [], group_by: null, visible_fields: ["title"], layout_config: {}, pin_order: 0, ...extra });

function setModules(modules: string[] | null) {
  setAppState((s) => ({ data: { ...s.data, workspace: { ...s.data.workspace, modules } } }));
}

const onSelect = vi.fn();
function renderTabs(props: Partial<React.ComponentProps<typeof ViewTabs>> = {}) {
  return render(<ViewTabs owner={{ kind: "node", id: NODE, name: "Reading list" }} activeKey="content"
    earnsWhiteboard={false} canManage fields={[]} onSelect={onSelect} {...props} />);
}
const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent?.trim());
const tab = (name: string | RegExp) => screen.getByRole("tab", { name });
async function openAdd() {
  fireEvent.click(screen.getByRole("button", { name: "Add a view" }));
  return screen.findByRole("dialog", { name: "Add a view" });
}

describe("ViewTabs", () => {
  beforeEach(() => {
    resetAppState(); resetOwnerViews(); localStorage.clear(); setModules(null);
    reply.views = [];
    for (const fn of [onSelect, writes.create, writes.update, writes.remove, confirm]) fn.mockClear();
  });

  it("a plain note has only 內容 and ＋", async () => {
    renderTabs();
    expect(tabNames()).toEqual(["Content"]);
    expect(screen.getByRole("button", { name: "Add a view" })).toBeInTheDocument();
    expect(tab("Content")).toHaveAttribute("aria-selected", "true");
  });

  it.each([["wide", false], ["phone", true]])("%s: a note with two views lists them and has ＋; the tab menu still works", async (_name, phone) => {
    setPhoneLayout(phone);
    try {
      reply.views = [saved("v1", "Shelf", "table")];
      renderTabs();
      await waitFor(() => expect(tabNames()).toEqual(["Content", "Shelf"]));
      expect(screen.getByRole("button", { name: "Add a view" })).toBeInTheDocument();
      fireEvent.contextMenu(tab("Shelf"));
      expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([...(phone ? [] : ["Open on the right"]), "Rename", "Move left", "Move right", "Make a variation…", "Delete view"]);
      if (phone) {
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        fireEvent.contextMenu(tab("Content"));
        expect(screen.queryByRole("menu")).toBeNull(); // nothing else in it: a phone has no 「開在右邊」
      }
    } finally { clearPhoneLayout(); }
  });

  it("a tag's row keeps ＋ and opens the add panel", async () => {
    renderTabs({ owner: { kind: "tag", id: NODE, name: "Books" } });
    expect((await openAdd())).toBeInTheDocument();
  });

  it("a note with only 內容 still shows its row (that is where ＋ is)", async () => {
    const { container } = renderTabs();
    await waitFor(() => expect(tabNames()).toEqual(["Content"]));
    expect(container.querySelector(".view-tabs")).not.toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "Add a view" })).toBeInTheDocument();
  });

  it("views already saved on the note become tabs in order, and a click opens one", async () => {
    reply.views = [saved("v1", "Shelf", "table"), saved("v2", "Month", "calendar", { pin_order: 1 })];
    renderTabs();
    await waitFor(() => expect(tabNames()).toEqual(["Content", "Shelf", "Month"]));
    fireEvent.click(tab("Month"));
    expect(onSelect).toHaveBeenCalledWith("v2");
  });

  it("a note with cards on a board, or a whiteboard note, lists the Canvas tab without anything stored", async () => {
    renderTabs({ earnsWhiteboard: true });
    await waitFor(() => expect(tabNames()).toEqual(["Content", "Canvas"]));
  });

  it("the Canvas tab shows whatever the stored module list says: the whiteboard is always on", async () => {
    setModules(["table"]);
    renderTabs({ earnsWhiteboard: true });
    await waitFor(() => expect(writes.create).not.toHaveBeenCalled());
    expect(tabNames()).toEqual(["Content", "Canvas"]);
  });

  it("＋ lists every view that is turned on", async () => {
    renderTabs();
    const all = within(await openAdd()).getAllByRole("button").map((b) => b.textContent);
    expect(all).toEqual(expect.arrayContaining(["Canvas", "Table", "Calendar"]));
  });

  it("＋ lists every view (slides too: always on) whatever Settings has turned on, and the whiteboard only when it is on and the page has none", async () => {
    setModules(["canvas"]);
    renderTabs({ earnsWhiteboard: true });
    await waitFor(() => expect(tabNames()).toEqual(["Content", "Canvas"]));
    const panel = await openAdd();
    // 「Handwriting」 joins once the note is known to have no pages of its own (read when 「＋」 opens).
    await waitFor(() => expect(within(panel).getAllByRole("button").map((b) => b.textContent)).toEqual(["Table", "Calendar", "Board", "Cards", "Slides", "Handwriting"]));
  });

  it("a handwriting note or a PDF is not offered 「Handwriting」 (its content is already pages), and nothing is read until 「＋」 opens", async () => {
    const attributes = vi.spyOn(reads.notes, "attributeValues");
    try {
      attributes.mockResolvedValue({ ink_data: "{}", pdf_url: null } as never);
      renderTabs();
      await waitFor(() => expect(tabNames()).toEqual(["Content"]));
      expect(attributes).not.toHaveBeenCalled(); // opening a note fetches no drawing
      const panel = await openAdd();
      await waitFor(() => expect(attributes).toHaveBeenCalledTimes(1));
      expect(within(panel).queryByRole("button", { name: "Handwriting" })).toBeNull();
    } finally { attributes.mockRestore(); }
  });

  it("a handwriting tab such a note already has stays, listed as already there", async () => {
    const attributes = vi.spyOn(reads.notes, "attributeValues");
    try {
      attributes.mockResolvedValue({ ink_data: "{}", pdf_url: null } as never);
      reply.views = [saved("h1", "Handwriting", "handwriting")];
      renderTabs();
      await waitFor(() => expect(tabNames()).toEqual(["Content", "Handwriting"]));
      const panel = await openAdd();
      await waitFor(() => expect(attributes).toHaveBeenCalled());
      const row = within(panel).getByRole("button", { name: /Handwriting/ });
      expect(row).toHaveTextContent("Already here");
    } finally { attributes.mockRestore(); reply.views = []; }
  });

  it("adding a table creates a saved view and opens its tab", async () => {
    renderTabs({ fields: [{ name: "mood", type: "text" }] });
    fireEvent.click(within(await openAdd()).getByRole("button", { name: "Table" }));
    await waitFor(() => expect(writes.create).toHaveBeenCalledTimes(1));
    expect(writes.create).toHaveBeenCalledWith({ kind: "node", id: NODE }, expect.objectContaining({ layout: "table", visible_fields: ["title", "mood", "updated_at"] }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("new-id"));
  });

  it("adding the whiteboard stores a canvas view and opens the Canvas tab", async () => {
    renderTabs();
    fireEvent.click(within(await openAdd()).getByRole("button", { name: "Canvas" }));
    await waitFor(() => expect(writes.create).toHaveBeenCalledWith({ kind: "node", id: NODE }, expect.objectContaining({ layout: "canvas" })));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("canvas"));
  });

  it("a board with no field to split by says what to add instead of a dead button", async () => {
    renderTabs({ fields: [] });
    fireEvent.click(within(await openAdd()).getByRole("button", { name: "Board" }));
    expect(await screen.findByRole("note")).toHaveTextContent(/needs a field to split into columns.*tag that has a Select field/);
    expect(screen.queryByRole("button", { name: "Add view" })).toBeNull();
  });

  it("on a tag, the board hint offers the tag's field settings", async () => {
    const edit = vi.fn();
    renderTabs({ owner: { kind: "tag", id: NODE, name: "task" }, fields: [], onEditFields: edit });
    fireEvent.click(within(await openAdd()).getByRole("button", { name: "Board" }));
    expect(await screen.findByRole("note")).toHaveTextContent(/Add a Select field/);
    fireEvent.click(screen.getByRole("button", { name: "Edit fields" }));
    expect(edit).toHaveBeenCalled();
  });

  it("a calendar with no date field explains the built-in dates and still can be added", async () => {
    renderTabs({ fields: [{ name: "mood", type: "text" }] });
    fireEvent.click(within(await openAdd()).getByRole("button", { name: "Calendar" }));
    expect(await screen.findByRole("note")).toHaveTextContent(/no date field yet.*Created date or Last edited date/);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Created date", "Last edited date"]);
    expect(screen.getByRole("button", { name: "Add view" })).toBeEnabled();
  });

  it("renames a view from its menu", async () => {
    reply.views = [saved("v1", "Shelf", "table")];
    renderTabs();
    await waitFor(() => tab("Shelf"));
    fireEvent.contextMenu(tab("Shelf"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "View name" });
    fireEvent.change(input, { target: { value: "Bookshelf" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(writes.update).toHaveBeenCalledWith({ kind: "node", id: NODE }, "v1", { name: "Bookshelf" }));
  });

  it("deletes a view after confirming, leaving its tab", async () => {
    reply.views = [saved("v1", "Shelf", "table")];
    renderTabs({ activeKey: "v1" });
    await waitFor(() => tab("Shelf"));
    fireEvent.contextMenu(tab("Shelf"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete view" }));
    await waitFor(() => expect(writes.remove).toHaveBeenCalledWith({ kind: "node", id: NODE }, "v1"));
    expect(onSelect).toHaveBeenCalledWith("content");
  });

  it("declining the confirmation deletes nothing and stays on the tab", async () => {
    confirm.mockResolvedValueOnce(false);
    reply.views = [saved("v1", "Shelf", "table")];
    renderTabs({ activeKey: "v1" });
    await waitFor(() => tab("Shelf"));
    fireEvent.contextMenu(tab("Shelf"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete view" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(writes.remove).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("removing the Canvas tab only hides the tab: it stores a hidden record and deletes nothing", async () => {
    renderTabs({ earnsWhiteboard: true, activeKey: "canvas" });
    await waitFor(() => tab("Canvas"));
    fireEvent.contextMenu(tab("Canvas"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove tab" }));
    await waitFor(() => expect(writes.create).toHaveBeenCalledWith({ kind: "node", id: NODE }, expect.objectContaining({ layout: "canvas", layout_config: { hidden: true } })));
    expect(writes.remove).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("content");
  });

  it("a stored Canvas tab is hidden by updating its record, never deleting it", async () => {
    reply.views = [saved("w", "Canvas", "canvas")];
    renderTabs();
    await waitFor(() => tab("Canvas"));
    fireEvent.contextMenu(tab("Canvas"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove tab" }));
    await waitFor(() => expect(writes.update).toHaveBeenCalledWith({ kind: "node", id: NODE }, "w", { layout_config_patch: { hidden: true } }));
    expect(writes.remove).not.toHaveBeenCalled();
  });

  it("a converted board's Canvas tab (the page opens on it) is removed like any tab: hidden, the board and its opening choice kept", async () => {
    reply.views = [saved("w", "Canvas", "canvas", { layout_config: { opens_first: true } })];
    renderTabs({ activeKey: "canvas" });
    await waitFor(() => tab("Canvas"));
    fireEvent.contextMenu(tab("Canvas"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove tab" }));
    await waitFor(() => expect(writes.update).toHaveBeenCalledWith({ kind: "node", id: NODE }, "w", { layout_config_patch: { hidden: true } }));
    expect(writes.remove).not.toHaveBeenCalled();
  });

  it("moves a tab with the menu, storing every changed place", async () => {
    reply.views = [saved("a", "A", "table", { pin_order: 0 }), saved("b", "B", "table", { pin_order: 1 })];
    renderTabs();
    await waitFor(() => tab("B"));
    fireEvent.contextMenu(tab("B"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move left" }));
    await waitFor(() => expect(writes.update).toHaveBeenCalledTimes(2));
    expect(writes.update).toHaveBeenCalledWith({ kind: "node", id: NODE }, "b", { pin_order: 0 });
    expect(writes.update).toHaveBeenCalledWith({ kind: "node", id: NODE }, "a", { pin_order: 1 });
  });

  it("「＋」 marks a kind the page already has, and choosing it opens that tab instead of adding", async () => {
    reply.views = [saved("a", "Shelf", "table"), saved("b", "Plan", "table", { pin_order: 1 })];
    renderTabs();
    await waitFor(() => tab("Shelf"));
    const panel = await openAdd();
    expect(within(panel).getByRole("button", { name: /^Table/ })).toHaveTextContent("Already here");
    expect(within(panel).getByRole("button", { name: /^Calendar/ })).not.toHaveTextContent("Already here");
    fireEvent.click(within(panel).getByRole("button", { name: /^Table/ }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("a"));
    expect(writes.create).not.toHaveBeenCalled();
  });

  it("「Make a variation…」 copies the view's settings right after it, makes room, and asks for its settings", async () => {
    reply.views = [
      saved("a", "Table", "table", { pin_order: 0, filters: [{ field: "status", op: "eq", value: "Open" }], visible_fields: ["title", "status"] }),
      saved("b", "Month", "calendar", { pin_order: 1 }),
    ];
    renderTabs();
    await waitFor(() => tab("Table"));
    fireEvent.contextMenu(tab("Table"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Make a variation…" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("new-id"));
    expect(writes.create).toHaveBeenCalledWith({ kind: "node", id: NODE }, expect.objectContaining({
      name: "Table 2", layout: "table", filters: [{ field: "status", op: "eq", value: "Open" }], visible_fields: ["title", "status"], pin_order: 1,
    }));
    expect(writes.update).toHaveBeenCalledWith({ kind: "node", id: NODE }, "b", { pin_order: 2 });
    expect(takeViewSettingsRequest("new-id")).toBe(true);
  });

  it("the whiteboard's and an inherited tab's menus have no 「Make a variation…」", async () => {
    reply.views = [saved("c", "Canvas", "canvas"), saved("i", "Shelf", "table", { pin_order: 1, inherited_from: "t1", inherited_name: "Books" })];
    renderTabs();
    await waitFor(() => tab("Canvas"));
    fireEvent.contextMenu(tab("Canvas"));
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Make a variation…" })).toBeNull();
  });

  it("dragging a tab onto another reorders them", async () => {
    reply.views = [saved("a", "A", "table", { pin_order: 0 }), saved("b", "B", "table", { pin_order: 1 })];
    renderTabs();
    await waitFor(() => tab("B"));
    const data = { setData: vi.fn(), effectAllowed: "" };
    fireEvent.dragStart(tab("B"), { dataTransfer: data });
    fireEvent.dragOver(tab("A"), { dataTransfer: data });
    fireEvent.drop(tab("A"), { dataTransfer: data });
    await waitFor(() => expect(writes.update).toHaveBeenCalledWith({ kind: "node", id: NODE }, "b", { pin_order: 0 }));
  });

  describe("side by side (docs/agents/decisions-ui.md, 視角＋並排)", () => {
    const drops: Array<[unknown, string, string]> = [];
    let stop = () => {};
    beforeEach(() => { drops.length = 0; stop = onSplitDrop((target, side, from) => { drops.push([target, side, from]); }); vi.stubGlobal("innerWidth", 1280); });
    afterEach(() => { stop(); splitDrag.cancel(); vi.unstubAllGlobals(); });
    const overWindow = (x: number) => act(() => { window.dispatchEvent(new MouseEvent("dragover", { clientX: x })); });

    it("dragging a tab out to the right half opens that view on the right", async () => {
      reply.views = [saved("a", "A", "table", { pin_order: 0 })];
      renderTabs();
      await waitFor(() => tab("A"));
      const data = { setData: vi.fn(), effectAllowed: "" };
      fireEvent.dragStart(tab("A"), { dataTransfer: data });
      expect(splitDrag.active()).toBe(true);
      overWindow(1000);
      act(() => { splitDrag.drop(1000); });
      expect(drops).toEqual([[{ kind: "note", id: NODE, tab: "a" }, "right", "tab"]]);
      expect(writes.update).not.toHaveBeenCalled();
    });

    it("dragging within the row still only reorders: nothing opens on the right", async () => {
      reply.views = [saved("a", "A", "table", { pin_order: 0 }), saved("b", "B", "table", { pin_order: 1 })];
      renderTabs();
      await waitFor(() => tab("B"));
      const data = { setData: vi.fn(), effectAllowed: "" };
      fireEvent.dragStart(tab("B"), { dataTransfer: data });
      overWindow(100);
      fireEvent.dragOver(tab("A"), { dataTransfer: data });
      fireEvent.drop(tab("A"), { dataTransfer: data });
      fireEvent.dragEnd(tab("B"), { dataTransfer: data });
      await waitFor(() => expect(writes.update).toHaveBeenCalledWith({ kind: "node", id: NODE }, "b", { pin_order: 0 }));
      expect(drops).toEqual([]);
      expect(splitDrag.active()).toBe(false);
    });

    it("Esc during the drag cancels it", async () => {
      reply.views = [saved("a", "A", "table")];
      renderTabs();
      await waitFor(() => tab("A"));
      render(<SplitDropHint />);
      fireEvent.dragStart(tab("A"), { dataTransfer: { setData: vi.fn(), effectAllowed: "" } });
      overWindow(1000);
      act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
      expect(splitDrag.drop(1000)).toBe(false);
      expect(drops).toEqual([]);
    });

    it("the tab's menu has 「開在右邊」 — for the content tab too, which has no other menu entry", async () => {
      reply.views = [saved("a", "A", "table")];
      renderTabs();
      await waitFor(() => tab("A"));
      fireEvent.contextMenu(tab("A"));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Open on the right" }));
      expect(drops).toEqual([[{ kind: "note", id: NODE, tab: "a" }, "right", "menu"]]);
      fireEvent.contextMenu(tab("Content"));
      expect(await screen.findByRole("menuitem", { name: "Open on the right" })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    });
  });

  describe("touch hold (lib/touchHold, as the sidebar's rows)", () => {
    const touch = (type: string, x: number, y: number, target: EventTarget = window) => act(() => {
      target.dispatchEvent(new PointerEvent(type, { pointerType: "touch", isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    });
    // jsdom has no layout: each tab sits in its own 100px column.
    const layout = () => {
      const tabs = screen.getAllByRole("tab");
      tabs.forEach((el, i) => { el.getBoundingClientRect = () => ({ left: i * 100, right: i * 100 + 100, top: 0, bottom: 30, width: 100, height: 30, x: i * 100, y: 0, toJSON() {} }) as DOMRect; });
      document.elementFromPoint = (x: number) => tabs[Math.min(tabs.length - 1, Math.floor(x / 100))] ?? null;
    };
    const hold = () => act(() => new Promise<void>((done) => setTimeout(done, 350)));
    // A lifted press swallows the click that trails it (swallowNextClick, 500 ms); the browser
    // sends that click at the finger. Send it, or it eats the next test's first click.
    afterEach(() => { window.dispatchEvent(new MouseEvent("click")); });
    async function two() {
      reply.views = [saved("a", "A", "table", { pin_order: 0 }), saved("b", "B", "table", { pin_order: 1 })];
      renderTabs();
      await waitFor(() => tab("B"));
      layout();
    }

    it("holding a tab and letting go with a little wobble opens its menu, nothing moves", async () => {
      await two();
      touch("pointerdown", 250, 10, tab("B"));
      await hold();
      touch("pointermove", 253, 12);
      touch("pointerup", 253, 12);
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(writes.update).not.toHaveBeenCalled();
    });

    it("holding then moving past the slop drags the tab to the place it is dropped, with no menu", async () => {
      await two();
      touch("pointerdown", 250, 10, tab("B"));
      await hold();
      touch("pointermove", 150, 10);
      touch("pointermove", 120, 10);
      touch("pointerup", 120, 10);
      expect(screen.queryByRole("menu")).toBeNull();
      await waitFor(() => expect(writes.update).toHaveBeenCalledWith({ kind: "node", id: NODE }, "b", { pin_order: 0 }));
    });

    it("a tab cannot be dropped on 內容", async () => {
      await two();
      touch("pointerdown", 250, 10, tab("B"));
      await hold();
      touch("pointermove", 20, 10);
      touch("pointerup", 20, 10);
      expect(writes.update).not.toHaveBeenCalled();
    });

    it("moving before the hold fires is a scroll: no menu, no drag", async () => {
      await two();
      touch("pointerdown", 250, 10, tab("B"));
      touch("pointermove", 200, 10);
      await hold();
      touch("pointerup", 200, 10);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(writes.update).not.toHaveBeenCalled();
    });

    it("a touch press takes the tabs off HTML5 drag; the mouse puts it back", async () => {
      await two();
      expect(tab("B")).toHaveAttribute("draggable", "true");
      touch("pointerdown", 250, 10, tab("B"));
      expect(tab("B")).not.toHaveAttribute("draggable", "true");
      touch("pointerup", 250, 10);
      fireEvent.pointerDown(tab("B"), { pointerType: "mouse", button: 0 });
      expect(tab("B")).toHaveAttribute("draggable", "true");
    });

    it("「內容」 can be held, but its menu offers only 「開在右邊」: it has nothing to rename, move or delete", async () => {
      await two();
      touch("pointerdown", 20, 10, tab("Content"));
      await hold();
      touch("pointerup", 20, 10);
      expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open on the right"]);
    });

    it("the browser's own long-press contextmenu is swallowed while held", async () => {
      await two();
      touch("pointerdown", 250, 10, tab("B"));
      await hold();
      fireEvent.contextMenu(tab("B"));
      expect(screen.queryByRole("menu")).toBeNull();
      touch("pointerup", 250, 10);
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    it("delete from the held menu asks first", async () => {
      await two();
      touch("pointerdown", 250, 10, tab("B"));
      await hold();
      touch("pointerup", 250, 10);
      await act(() => new Promise<void>((done) => setTimeout(done, 550))); // the click that trails the lift is swallowed
      fireEvent.click(await screen.findByRole("menuitem", { name: "Delete view" }));
      await waitFor(() => expect(confirm).toHaveBeenCalled());
      await waitFor(() => expect(writes.remove).toHaveBeenCalled());
    });
  });

  it("someone who may not change the page sees the tabs and no ＋; the menu only offers 「開在右邊」 and nothing reorders", async () => {
    reply.views = [saved("v1", "Shelf", "table"), saved("v2", "Other", "table")];
    renderTabs({ canManage: false });
    await waitFor(() => tab("Shelf"));
    expect(screen.queryByRole("button", { name: "Add a view" })).toBeNull();
    fireEvent.contextMenu(tab("Shelf"));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open on the right"]);
    // Draggable to the side, but dropping it on another tab changes no order.
    expect(tab("Shelf")).toHaveAttribute("draggable", "true");
    const data = { setData: vi.fn(), effectAllowed: "" };
    fireEvent.dragStart(tab("Other"), { dataTransfer: data });
    fireEvent.drop(tab("Shelf"), { dataTransfer: data });
    expect(writes.update).not.toHaveBeenCalled();
  });

  it("an open tab that no longer exists falls back to 內容", async () => {
    reply.views = [saved("v1", "Shelf", "table")];
    renderTabs({ activeKey: "gone" });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("content"));
  });

  it("a saved tab id is not given up before the views are known", async () => {
    reply.views = [saved("v1", "Shelf", "table")];
    renderTabs({ activeKey: "v1" });
    await waitFor(() => tab("Shelf"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
