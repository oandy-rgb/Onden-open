// @vitest-environment jsdom
// 並排: two sides may show the same note. Hiding or adding 「內容」 on one side (the left tab row) is a change of the
// note's views, which both sides read from the one store (lib/ownerViews): the right side's tab list follows, and a right
// side showing 「內容」 when it is hidden moves to the note's default tab.
import "./helpers/offlineNetwork";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { resetOwnerViews } from "../lib/ownerViews";

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
vi.mock("../modules", async (original) => ({ ...(await original<object>()), loadRssQuote: async () => ({ appendToNote: vi.fn(), appendQuote: vi.fn() }) }));
const NODE = "n1";
type Stored = Record<string, unknown> & { id: string; layout: string };
const store = vi.hoisted(() => ({ views: [] as Stored[] }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn(async (path: string) => {
  if (path === "/api/nodes/n1/views") return { views: store.views };
  return { views: [] };
}) }));
// The writers as the server would answer them: the record is stored, and the next read of the views shows it.
vi.mock("../lib/data/domainWriters", async (load) => {
  const actual = await load<typeof import("../lib/data/domainWriters")>();
  return { ...actual, viewWriter: {
    create: vi.fn(async (_owner: unknown, input: Record<string, unknown>) => { store.views.push({ id: "c1", node_id: NODE, filters: [], sorts: [], group_by: null, visible_fields: [], pin_order: 0, layout_config: {}, ...input } as unknown as Stored); return "c1"; }),
    update: vi.fn(async (_owner: unknown, id: string, changes: Record<string, unknown>) => {
      const view = store.views.find((v) => v.id === id)!;
      const { layout_config_patch: patch, ...rest } = changes as { layout_config_patch?: Record<string, unknown> };
      Object.assign(view, rest);
      if (patch) {
        const next = { ...(view.layout_config as Record<string, unknown>) };
        for (const [key, value] of Object.entries(patch)) { if (value === null) delete next[key]; else next[key] = value; }
        view.layout_config = next;
      }
      return { status: "ok" };
    }),
    remove: vi.fn(),
  } };
});
vi.mock("../components/ConfirmDialog", async (load) => ({ ...await load<typeof import("../components/ConfirmDialog")>(), confirmDialog: vi.fn(async () => true) }));

import SplitPane from "../components/splitView/SplitPane";
import { ViewTabs } from "../components/viewTabs";

const row = (id: string): ContentNode => ({ id, title: "Shared note", slug: id, markdown: "the text", node_type: "content", source_type: "manual", parent_id: null }) as ContentNode;
const shelf: Stored = { id: "v1", node_id: NODE, name: "Shelf", layout: "table", filters: [], sorts: [], group_by: null, visible_fields: ["title"], layout_config: {}, pin_order: 0 };
const handlers = () => ({
  outlet: { refresh: vi.fn(async () => {}), dueSoon: {} as never, openModule: vi.fn() },
  onOpenNoteLeft: vi.fn(), onChangeTarget: vi.fn(), onSwap: vi.fn(), onClose: vi.fn(), refresh: vi.fn(async () => {}),
});

beforeEach(() => {
  store.views = [{ ...shelf }];
  resetOwnerViews();
  resetAppState({ data: { ...noWorkspaceData, actor_is_owner: true, nodes: [row(NODE)] }, online: true });
});
afterEach(() => cleanup());

describe("hiding and adding 「內容」 with the same note on both sides", () => {
  it("the right side's tab list follows the left's tab row; a right side on 「內容」 moves to the default tab when it is hidden", async () => {
    const side = handlers();
    const onSelect = vi.fn();
    const { rerender } = render(<>
      <ViewTabs owner={{ kind: "node", id: NODE, name: "Shared note" }} activeKey="v1" earnsWhiteboard={false} canManage fields={[]} onSelect={onSelect} />
      <SplitPane target={{ kind: "note", id: NODE, tab: "content" }} {...side} />
    </>);
    await waitFor(() => expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Content", "Shelf"]));
    // The right side lists the same tabs, and shows 「內容」 (the note's text).
    fireEvent.click(await screen.findByRole("button", { name: /Content/ }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Content", "Shelf"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    // Remove 「內容」 on the left.
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Content" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Remove tab" }));
    await waitFor(() => expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Shelf"]));
    // The right side was on 「內容」: it moves to the first tab showing.
    await waitFor(() => expect(side.onChangeTarget).toHaveBeenCalledWith({ kind: "note", id: NODE, tab: "v1" }));

    // Re-render the right side on that tab: its list no longer has 「內容」.
    rerender(<>
      <ViewTabs owner={{ kind: "node", id: NODE, name: "Shared note" }} activeKey="v1" earnsWhiteboard={false} canManage fields={[]} onSelect={onSelect} />
      <SplitPane target={{ kind: "note", id: NODE, tab: "v1" }} {...side} />
    </>);

    // Add it back from 「＋」 on the left: both rows list it again, last.
    fireEvent.click(screen.getByRole("button", { name: "Add a view" }));
    const panel = await screen.findByRole("dialog", { name: "Add a view" });
    await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "Content" })); });
    await waitFor(() => expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Shelf", "Content"]));
    fireEvent.click(screen.getByRole("button", { name: /Shelf ▾/ }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Shelf", "Content"]);
  });
});
