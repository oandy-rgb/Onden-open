// One chooser for a view's layout: 「＋」 and the ⚙ menu ask the same question,
// store the answer the same way, and the ⚙ switch keeps the tab's name honest.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import CollectionView from "../components/collections/CollectionView";
import { resetOwnerViews } from "../lib/ownerViews";
import { resetAppState } from "../lib/appStore";
import { nameAfterViewChange } from "../lib/viewTabs";
import { requestViewSettings } from "../lib/viewSettingsRequest";
import { viewNameParts } from "../components/collections";
import type { FieldDef } from "../lib/api";

const updated = vi.hoisted(() => [] as unknown[][]);
const created = vi.hoisted(() => [] as unknown[][]);
vi.mock("../lib/data/domainWriters", async (load) => {
  const actual = await load<typeof import("../lib/data/domainWriters")>();
  return {
    ...actual,
    viewWriter: {
      ...actual.viewWriter,
      update: vi.fn(async (...args: unknown[]) => { updated.push(args); }),
      create: vi.fn(async (...args: unknown[]) => { created.push(args); return null; }),
    },
  };
});

const PARENT = "00000000-0000-4000-8000-00000000b001";
const reply = vi.hoisted(() => ({ views: [] as Array<Record<string, unknown>> }));
vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      if (path === `/api/nodes/${PARENT}/views`) return { views: reply.views };
      const exec = /\/views\/([^/]+)\/exec/.exec(path);
      if (exec) return { rows: [], total: 0, next: null, view: { layout: "table", group_by: null, visible_fields: ["title"], layout_config: {}, field_meta: {} } };
      throw new Error(`unexpected ${path}`);
    }),
  };
});

const fields: FieldDef[] = [
  { name: "due", type: "date", label: "Due" },
  { name: "status", type: "select", label: "Status" },
];
const saved = (extra: Record<string, unknown>) => ({
  id: "v1", node_id: PARENT, name: "Cards", layout: "gallery", filters: [], sorts: [], group_by: null,
  visible_fields: ["title", "updated_at"], layout_config: {}, pin_order: 0, ...extra,
});
const pane = (schemaFields: FieldDef[] = fields) =>
  render(<CollectionView source={{ kind: "node", id: PARENT, name: "Reading list" }} viewId="v1" canManage schemaFields={schemaFields} />);

async function chooseFromMenu(layout: string) {
  fireEvent.click(await screen.findByRole("button", { name: "View options" }));
  const menu = await screen.findByRole("menu", { name: "View options" });
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: layout }));
}

describe("changing a view's layout from the ⚙ menu", () => {
  beforeEach(() => { resetAppState(); resetOwnerViews(); localStorage.clear(); updated.length = 0; created.length = 0; reply.views = []; });

  it("cards → calendar asks for the date field first, stores it as adding does, and renames an automatic name", async () => {
    reply.views = [saved({ name: "Cards" })];
    pane();
    await chooseFromMenu("Calendar");
    expect(updated).toHaveLength(0);
    const panel = await screen.findByRole("dialog", { name: "View options" });
    fireEvent.change(within(panel).getByLabelText("Date field"), { target: { value: "due" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Change layout" }));
    await waitFor(() => expect(updated).toHaveLength(1));
    expect(updated[0]![2]).toEqual({
      layout: "calendar", name: "Calendar · Due", layout_config: { date_field: "due" }, visible_fields: ["title", "updated_at", "due"],
    });
  });

  it("a name the person typed stays", async () => {
    reply.views = [saved({ name: "Reading plan" })];
    pane();
    await chooseFromMenu("Calendar");
    const panel = await screen.findByRole("dialog", { name: "View options" });
    fireEvent.click(within(panel).getByRole("button", { name: "Change layout" }));
    await waitFor(() => expect(updated).toHaveLength(1));
    expect(updated[0]![2]).not.toHaveProperty("name");
    expect(updated[0]![2]).toMatchObject({ layout: "calendar", layout_config: { date_field: "due" } });
  });

  it("a layout that asks for nothing switches at once, and a numbered automatic name takes a free number", async () => {
    reply.views = [saved({ name: "Cards 2" }), saved({ id: "v2", name: "Table", layout: "table", pin_order: 1 })];
    pane();
    await chooseFromMenu("Table");
    await waitFor(() => expect(updated).toHaveLength(1));
    expect(updated[0]![2]).toEqual({ layout: "table", name: "Table 2" });
  });

  it("says what to add when there is no field a board could split by", async () => {
    reply.views = [saved({ name: "Cards" })];
    pane([]);
    await chooseFromMenu("Board");
    const panel = await screen.findByRole("dialog", { name: "View options" });
    expect(within(panel).getByRole("note")).toHaveTextContent(/needs a field to split into columns/);
  });

  it("the board's Group by lists the owner's select field although the view does not show it, and stores it as visible", async () => {
    reply.views = [saved({ name: "Board", layout: "kanban", visible_fields: ["title"] })];
    pane();
    const select = await screen.findByLabelText("Group by");
    expect(within(select).getByRole("option", { name: "Status" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "status" } });
    await waitFor(() => expect(updated).toHaveLength(1));
    expect(updated[0]![2]).toEqual({ group_by: "status", visible_fields: ["title", "status"], name: "Board · Status" });
  });

  it("the menu has no 「Reload query results」", async () => {
    reply.views = [saved({})];
    pane();
    fireEvent.click(await screen.findByRole("button", { name: "View options" }));
    expect(screen.queryByRole("menuitem", { name: "Reload query results" })).toBeNull();
  });
});

describe("copying a view", () => {
  beforeEach(() => { resetAppState(); resetOwnerViews(); created.length = 0; });

  it("names the copy 「X 2」", async () => {
    reply.views = [saved({ id: "v1", name: "Shelf", inherited_from: PARENT, inherited_name: "Parent" }), saved({ id: "v0", name: "Shelf", layout: "table" })];
    pane();
    fireEvent.click(await screen.findByRole("button", { name: "Copy as this tag's own" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]![1]).toMatchObject({ name: "Shelf 2" });
  });
});

describe("an automatic name follows the kind and what sets the view apart", () => {
  const parts = (title: string, qualifier: string | null = null) => ({ title, qualifier });

  it("follows only an automatic name", () => {
    expect(nameAfterViewChange("卡片", parts("卡片"), parts("月曆"), [])).toBe("月曆");
    expect(nameAfterViewChange("卡片 3", parts("卡片"), parts("月曆"), ["月曆"])).toBe("月曆 2");
    expect(nameAfterViewChange("卡片集", parts("卡片"), parts("月曆"), [])).toBeNull();
    expect(nameAfterViewChange("My cards", parts("Cards"), parts("Calendar"), [])).toBeNull();
  });

  it("adds, changes and drops what sets the view apart", () => {
    expect(nameAfterViewChange("Table", parts("Table"), parts("Table", "Open"), [])).toBe("Table · Open");
    expect(nameAfterViewChange("Table · Open", parts("Table", "Open"), parts("Table", "Done"), [])).toBe("Table · Done");
    expect(nameAfterViewChange("Table · Open", parts("Table", "Open"), parts("Table"), [])).toBe("Table");
    expect(nameAfterViewChange("Table · Open", parts("Table", "Open"), parts("Table", "Done"), ["Table · Done"])).toBe("Table · Done 2");
    expect(nameAfterViewChange("Open items", parts("Table", "Open"), parts("Table", "Done"), [])).toBeNull();
  });

  it("names the date or column field, else the first filter, by their display names", () => {
    expect(viewNameParts({ layout: "calendar", layout_config: { date_field: "due" } }, fields)).toEqual({ title: "Calendar", qualifier: "Due" });
    expect(viewNameParts({ layout: "calendar", layout_config: { date_field: "created_at" } })).toEqual({ title: "Calendar", qualifier: "Created date" });
    expect(viewNameParts({ layout: "kanban", group_by: "status" }, fields)).toEqual({ title: "Board", qualifier: "Status" });
    expect(viewNameParts({ layout: "table", filters: [{ field: "status", op: "eq", value: "Open" }] })).toEqual({ title: "Table", qualifier: "Open" });
    expect(viewNameParts({ layout: "table", filters: [{ field: "status", op: "empty" }] }, fields)).toEqual({ title: "Table", qualifier: "Status" });
    expect(viewNameParts({ layout: "table" })).toEqual({ title: "Table", qualifier: null });
  });
});

describe("a view made by 「Make a variation…」", () => {
  beforeEach(() => { resetAppState(); resetOwnerViews(); localStorage.clear(); updated.length = 0; reply.views = []; });

  it("opens on its own settings", async () => {
    reply.views = [saved({ name: "Table", layout: "table" })];
    requestViewSettings("v1");
    pane();
    expect(await screen.findByRole("menu", { name: "View options" })).toBeInTheDocument();
  });

  it("does not open the settings of a view nobody asked for", async () => {
    reply.views = [saved({ name: "Table", layout: "table" })];
    requestViewSettings("another");
    pane();
    await screen.findByRole("button", { name: "View options" });
    expect(screen.queryByRole("menu", { name: "View options" })).toBeNull();
  });
});
