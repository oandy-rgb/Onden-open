// 「＋」 of a note's title strip, with the real shared hook (viewTabs/useAddView): the kinds
// listed are the same for a note and a tag, choosing one writes the view and
// opens its tab, and no second floating panel appears for a kind that needs none.
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ViewTabs } from "../components/viewTabs";
import { resetAppState, setAppState } from "../lib/appStore";
import { resetOwnerViews } from "../lib/ownerViews";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
const writes = vi.hoisted(() => ({ create: vi.fn(async () => "new-id" as string | null), update: vi.fn(async () => ({ status: "ok" })), remove: vi.fn(async () => {}) }));
vi.mock("../lib/data/domainWriters", async (load) => {
  const actual = await load<typeof import("../lib/data/domainWriters")>();
  return { ...actual, viewWriter: { create: writes.create, update: writes.update, remove: writes.remove } };
});
const NODE = "00000000-0000-4000-8000-00000000a001";
const reply = vi.hoisted(() => ({ views: [] as unknown[] }));
vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return { ...actual, api: vi.fn(async (path: string) => {
    if (path === `/api/nodes/${NODE}/views`) return { views: reply.views };
    throw new Error(`unexpected ${path}`);
  }) };
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  resetAppState(); resetOwnerViews(); reply.views = [];
  setAppState((s) => ({ data: { ...s.data, workspace: { ...s.data.workspace, modules: null } } }));
  for (const fn of [writes.create, writes.update, writes.remove]) fn.mockClear();
});
afterEach(() => clearPhoneLayout());

const onSelect = vi.fn();
function Note({ canManage = true }: { canManage?: boolean }) {
  return <ViewTabs owner={{ kind: "node", id: NODE, name: "Reading list" }} activeKey="content" earnsWhiteboard={false} canManage={canManage}
    fields={[{ name: "status", type: "select", options: ["a"] }]} onSelect={onSelect} />;
}
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Add a view" }));

const panel = () => within(screen.getByRole("dialog", { name: "Add a view" }));
const view = (id: string, name: string, layout: string, pin_order = 0) =>
  ({ id, node_id: NODE, name, layout, filters: [], sorts: [], group_by: null, visible_fields: ["title"], layout_config: {}, pin_order });

describe.each([["wide", false], ["phone", true]])("＋ on a note (%s)", (_name, phone) => {
  beforeEach(() => { onSelect.mockClear(); setPhoneLayout(phone); });

  it("lists the whiteboard first, then every built-in view, then 簡報", async () => {
    render(<Note />);
    openMenu();
    expect(panel().getAllByRole("button").map((el) => el.textContent).slice(0, 6)).toEqual(["Canvas", "Table", "Calendar", "Board", "Cards", "Slides"]);
  });

  it("a table is added at once under its own name and its tab opens", async () => {
    render(<Note />);
    openMenu();
    fireEvent.click(panel().getByRole("button", { name: "Table" }));
    await waitFor(() => expect(writes.create).toHaveBeenCalledWith({ kind: "node", id: NODE }, expect.objectContaining({ name: "Table", layout: "table", visible_fields: ["title", "status", "updated_at"] })));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("new-id"));
  });

  it("a kind the note already has opens the first such tab and adds nothing", async () => {
    reply.views = [view("t1", "Shelf", "table"), view("t2", "Shelf 2", "table", 1)];
    render(<Note />);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
    openMenu();
    fireEvent.click(panel().getByRole("button", { name: /^Table/ }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("t1"));
    expect(writes.create).not.toHaveBeenCalled();
  });

  it("the whiteboard is stored as a canvas view and the Canvas tab opens", async () => {
    render(<Note />);
    openMenu();
    fireEvent.click(panel().getByRole("button", { name: "Canvas" }));
    await waitFor(() => expect(writes.create).toHaveBeenCalledWith({ kind: "node", id: NODE }, expect.objectContaining({ layout: "canvas" })));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("canvas"));
  });

  it("Slides is added as a stored view of layout slides", async () => {
    render(<Note />);
    openMenu();
    fireEvent.click(panel().getByRole("button", { name: "Slides" }));
    await waitFor(() => expect(writes.create).toHaveBeenCalledWith({ kind: "node", id: NODE }, expect.objectContaining({ layout: "slides", name: "Slides" })));
  });

  it("still offers Slides when the workspace's stored module list lacks it (always on)", async () => {
    setAppState((s) => ({ data: { ...s.data, workspace: { ...s.data.workspace, modules: ["canvas"] } } }));
    render(<Note />);
    openMenu();
    expect(panel().getByRole("button", { name: /Slides/ })).toBeTruthy();
  });

  it("someone who may not change the page's views has no ＋", () => {
    render(<Note canManage={false} />);
    expect(screen.queryByRole("button", { name: "Add a view" })).toBeNull();
  });
});
