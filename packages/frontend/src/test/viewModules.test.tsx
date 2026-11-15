// View modules (docs/architecture/views-as-modules.md, V2): 「＋」 (the tab row) offers
// every built-in view, whatever the workspace has turned on; a view module
// asks for its one field, which the new view stores. The calendar / cards use the
// field chosen for them before guessing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { LayoutDashboard } from "lucide-react";
import AddViewPanel from "../components/viewTabs/AddViewPanel";
import { useAddView, type AddViewSource } from "../components/viewTabs/useAddView";
import { layoutChoices, type LayoutChoice } from "../components/collections";
import { usePopover } from "../components/ui";
import { calendarDateField } from "../components/viewLayoutKit";
import ModuleLibrary from "../components/ModuleLibrary";
import { MODULES, inModuleLibrary, isAlwaysOn } from "../modules";
import type { FieldDef } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";

function workspace(modules: string[] | null) {
  resetAppState();
  setAppState((s) => ({ data: { ...s.data, actor_role: "admin", actor_is_owner: true, workspace: { ...s.data.workspace, modules } } }));
}
afterEach(() => resetAppState());

const fields: FieldDef[] = [
  { name: "author", type: "text", label: "Author" },
  { name: "finished", type: "date", label: "Finished" },
  { name: "status", type: "select", options: ["reading", "done"] },
  { name: "cover", type: "media" },
];

type PanelProps = Partial<AddViewSource> & { offerWhiteboard?: boolean };
function Harness({ source }: { source: AddViewSource }) {
  const [open, setOpen] = useState(true);
  const popover = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false), placement: "bottom-start" });
  return <><button ref={popover.anchor} type="button">View</button>{open && <AddViewPanel popover={popover} onClose={() => setOpen(false)} source={source} />}</>;
}
// The panel only lists the source's choices and hands the pick back; what
// `add` stores (a free name, the visible fields, the tab opened) is
// viewTabs/useAddView, covered by ViewTabs.test and NoteActions.test.
function menu({ offerWhiteboard, ...props }: PanelProps = {}) {
  const add = vi.fn(async (_choice: LayoutChoice, _field: string) => {});
  const choices = [...(offerWhiteboard ? [{ layout: "canvas", title: "Canvas", Icon: LayoutDashboard }] : []), ...layoutChoices()];
  render(<Harness source={{ choices, fields, ownerKind: "tag", busy: false, add, ...props }} />);
  return { add, panel: screen.getByRole("dialog", { name: "Add a view" }) };
}

describe("「＋」 in the tab row", () => {
  it("offers every built-in view, whatever the workspace has turned on", () => {
    workspace(["calendar", "gallery"]);
    expect(within(menu().panel).getAllByRole("button").map((b) => b.textContent)).toEqual(["Table", "Calendar", "Board", "Cards"]);
  });

  it("still offers every view in a workspace that imported no view module", () => {
    workspace([]);
    const { panel } = menu();
    expect(within(panel).getAllByRole("button").map((b) => b.textContent)).toEqual(["Table", "Calendar", "Board", "Cards"]);
    expect(within(panel).queryByText(/No view is turned on/)).toBeNull();
  });

  it("adds a table at once", async () => {
    workspace(null);
    const { add, panel } = menu();
    fireEvent.click(within(panel).getByRole("button", { name: "Table" }));
    await vi.waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ layout: "table" }), ""));
    expect(screen.queryByRole("dialog", { name: "Add a view" })).toBeNull();
  });

  it("a calendar asks for a date field (date fields and the built-in dates) and stores it", async () => {
    workspace(null);
    const { add, panel } = menu();
    fireEvent.click(within(panel).getByRole("button", { name: "Calendar" }));
    const select = within(panel).getByRole("combobox", { name: "Date field" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Finished", "Created date", "Last edited date"]);
    fireEvent.click(within(panel).getByRole("button", { name: "Add view" }));
    await vi.waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ layout: "calendar" }), "finished"));
  });

  it("a board groups by the field picked, select fields first", async () => {
    workspace(null);
    const { add, panel } = menu();
    fireEvent.click(within(panel).getByRole("button", { name: "Board" }));
    const select = within(panel).getByRole("combobox", { name: "Columns by" });
    expect((select as HTMLSelectElement).value).toBe("status");
    fireEvent.click(within(panel).getByRole("button", { name: "Add view" }));
    await vi.waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ layout: "kanban" }), "status"));
  });

  it("cards may leave the cover automatic", async () => {
    workspace(null);
    const { add, panel } = menu();
    fireEvent.click(within(panel).getByRole("button", { name: "Cards" }));
    expect((within(panel).getByRole("combobox", { name: "Cover" }) as HTMLSelectElement).value).toBe("");
    fireEvent.click(within(panel).getByRole("button", { name: "Add view" }));
    await vi.waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ layout: "gallery" }), ""));
  });

  it("a board on a tag without fields says what to add instead of a dead button; a calendar still can be added", () => {
    workspace(null);
    const { panel } = menu({ fields: [] });
    fireEvent.click(within(panel).getByRole("button", { name: "Board" }));
    expect(within(panel).getByRole("note")).toHaveTextContent("Add a Select field");
    expect(within(panel).queryByRole("button", { name: "Add view" })).toBeNull();
    // A calendar always has the built-in dates to fall back on.
    fireEvent.click(within(panel).getByRole("button", { name: "Back" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Calendar" }));
    expect(within(panel).getByRole("button", { name: "Add view" })).toBeEnabled();
  });

  it("offers the whiteboard first when the page has none and it is turned on", () => {
    workspace(null);
    const { panel } = menu({ offerWhiteboard: true });
    expect(within(panel).getAllByRole("button").map((b) => b.textContent)[0]).toBe("Canvas");
  });
});

describe("the calendar's date field", () => {
  it("is the one chosen for the view; a view with none uses the last-edited date, whatever its fields are called", () => {
    expect(calendarDateField("exam")).toBe("exam");
    expect(calendarDateField(undefined)).toBe("updated_at");
  });
});

describe("Settings › Features", () => {
  it("lists no always-on way of seeing: not the view modules, not the whiteboard", () => {
    workspace([]);
    render(<ModuleLibrary online />);
    const alwaysOn = MODULES.filter(isAlwaysOn);
    expect(alwaysOn.map((m) => m.id)).toEqual(expect.arrayContaining(["canvas", "table", "calendar", "kanban", "gallery"]));
    for (const mod of alwaysOn) {
      expect(inModuleLibrary(mod)).toBe(false);
      expect(screen.queryByRole("button", { name: mod.library.title })).toBeNull();
      expect(document.querySelector(`[data-module="${mod.id}"]`)).toBeNull();
    }
    for (const name of ["Table", "Calendar", "Board", "Cards", "Canvas"]) expect(screen.queryByRole("button", { name })).toBeNull();
    // The library's `group: "views"` is gone: nothing sits in a views group.
    expect(MODULES.some((m) => (m.library as { group?: string }).group === "views")).toBe(false);
  });
});

describe("「＋」 offers the whiteboard whatever the stored module list says", () => {
  const actions = { create: vi.fn(), addWhiteboard: vi.fn(), takenNames: [] } as unknown as Parameters<typeof useAddView>[0]["actions"];
  for (const modules of [[], ["rss"], null]) {
    it(`stored list ${JSON.stringify(modules)}`, () => {
      workspace(modules);
      const { result } = renderHook(() => useAddView({ tabs: [], actions, fields, ownerKind: "tag", onSelect: vi.fn() }));
      expect(result.current.choices[0]?.layout).toBe("canvas");
    });
  }
});
