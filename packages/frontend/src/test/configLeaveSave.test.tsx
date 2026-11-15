// Settings that save a moment after typing (a debounce) must also save when the page is hidden or closed,
// not only when their panel unmounts: a tab closed inside the debounce window would lose the edit.
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({ viewUpdate: vi.fn(), schemaUpdate: vi.fn(), saveSettings: vi.fn() }));
vi.mock("../lib/data", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/data")>();
  return {
    ...mod,
    viewWriter: { ...mod.viewWriter, update: spies.viewUpdate },
    tagSchemaWriter: { ...mod.tagSchemaWriter, update: spies.schemaUpdate },
    reads: { ...mod.reads, tags: { ...mod.reads.tags, all: vi.fn(async () => []) } },
  };
});
vi.mock("../modules/website/websiteWriter", () => ({ makeWebsiteWriter: () => ({ saveSettings: spies.saveSettings }) }));
vi.mock("../lib/capabilities", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/capabilities")>()), useIsOwner: () => true }));

import ViewBuilder from "../components/collections/ViewBuilder";
import { useSchemaDraft } from "../components/tagPage/structure/useSchemaDraft";
import SiteBasicsSettings from "../modules/website/SiteBasicsSettings";
import type { Tag } from "../lib/api";

beforeEach(() => { vi.useFakeTimers(); spies.viewUpdate.mockResolvedValue({ status: "synced" }); spies.schemaUpdate.mockResolvedValue({ status: "synced" }); spies.saveSettings.mockResolvedValue({ status: "synced" }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const hide = () => act(() => { window.dispatchEvent(new Event("pagehide")); });

it("view builder: a pending filter is sent when the page is hidden, inside the debounce window", () => {
  const view = { id: "v1", name: "All", layout: "table", filters: [], sorts: [], group_by: null, layout_config: {} } as never;
  render(<ViewBuilder owner={{ kind: "tag", id: "tag-1" } as never} view={view} fieldKeys={["price"]} onSaved={() => {}} />);
  fireEvent.click(screen.getByText("Add filter"));
  expect(spies.viewUpdate).not.toHaveBeenCalled();
  hide();
  expect(spies.viewUpdate).toHaveBeenCalledTimes(1);
  expect(spies.viewUpdate.mock.calls[0]![1]).toBe("v1");
});

it("tag schema editor: a pending change is sent when the page is hidden, to the tag it was made on", () => {
  const tag = { id: "tag-1", schema_fields: [] } as unknown as Tag;
  const { result } = renderHook(() => useSchemaDraft({ tag, online: false, onLoadError: () => {} }));
  act(() => result.current.save({ fields: [{ name: "price", type: "number" }] } as never));
  expect(spies.schemaUpdate).not.toHaveBeenCalled();
  hide();
  expect(spies.schemaUpdate).toHaveBeenCalledTimes(1);
  expect(spies.schemaUpdate.mock.calls[0]![0]).toBe("tag-1");
});

it("site basics: a typed description is sent (keepalive) when the page is hidden", () => {
  render(<SiteBasicsSettings ctx={{} as never} />);
  fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "About my site" } });
  expect(spies.saveSettings).not.toHaveBeenCalled();
  hide();
  expect(spies.saveSettings).toHaveBeenCalledTimes(1);
  expect(spies.saveSettings.mock.calls[0]![0]).toMatchObject({ description: "About my site" });
  expect(spies.saveSettings.mock.calls[0]![1]).toMatchObject({ keepalive: true });
});
