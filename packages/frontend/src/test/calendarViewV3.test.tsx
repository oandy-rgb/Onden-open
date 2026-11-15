// V3 (docs/architecture/views-as-modules.md): a calendar view re-runs when
// someone else changes data (GAP-158), and its date field can be changed
// from the view's ⋯ menu — the fix for old views that guessed the wrong one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CollectionView from "../components/collections/CollectionView";
import { resetAppState, setAppState } from "../lib/appStore";
import { PREFS, setPrefJson } from "../lib/prefs";
import { resetOwnerViews } from "../lib/ownerViews";

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));

const viewUpdates: unknown[][] = [];
vi.mock("../lib/data/domainWriters", async (load) => {
  const actual = await load<typeof import("../lib/data/domainWriters")>();
  return { ...actual, viewWriter: { ...actual.viewWriter, update: vi.fn(async (...args: unknown[]) => { viewUpdates.push(args); return { ok: true }; }) } };
});

const liveRefetches: Array<() => unknown> = [];
vi.mock("../lib/liveInvalidation", async (original) => ({
  ...await original<typeof import("../lib/liveInvalidation")>(),
  useLiveRefetch: (_topic: string, refetch: () => unknown) => { liveRefetches.push(refetch); },
}));

const TAG = "00000000-0000-4000-8000-0000000000e1";
// The 15th of the month the calendar opens on.
const now = new Date();
const EXAM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-15`;
let view = { id: "cal", tag_id: TAG, name: "Exams", layout: "calendar", filters: [], sorts: [], group_by: null,
  visible_fields: ["title", "exam"], layout_config: {} as Record<string, unknown>, pin_order: 0 };
const calls: Array<{ path: string; method: string; body?: unknown }> = [];

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (path === `/api/tags/${TAG}/views`) return { views: [view] };
      if (path === `/api/tags/${TAG}/views/cal/exec`) {
        return { rows: [{ id: "n1", title: "Algebra", slug: "n1", updated_at: `${EXAM}T09:00:00Z`, created_at: `${EXAM}T09:00:00Z`, attributes: { exam: EXAM } }],
          count: 1, view: { layout: "calendar", group_by: null, visible_fields: view.visible_fields, layout_config: view.layout_config } };
      }
      if (path === `/api/tags/${TAG}/views/cal` && init?.method === "PATCH") {
        view = { ...view, ...JSON.parse(init.body as string) };
        return { ok: true };
      }
      return {};
    }),
  };
});

const execCalls = () => calls.filter((c) => c.path.endsWith("/exec")).length;

describe("calendar view, V3", () => {
  beforeEach(() => {
    resetAppState();
    setAppState((s) => ({ data: { ...s.data, actor_role: "admin", actor_is_owner: true, workspace: { ...s.data.workspace, modules: null } } }));
    resetOwnerViews();
    setPrefJson(PREFS.calendarMonths, {});
    calls.length = 0;
    liveRefetches.length = 0;
    viewUpdates.length = 0;
  });

  it("re-runs the open view when another change arrives", async () => {
    render(<CollectionView source={{ kind: "tag", id: TAG, name: "Exams" }} viewId="cal" canManage />);
    await screen.findByText("Algebra");
    const before = execCalls();
    await liveRefetches[liveRefetches.length - 1]!();
    await waitFor(() => expect(execCalls()).toBe(before + 1));
  });

  it("changes the date field from the view's ⋯ menu", async () => {
    render(<CollectionView source={{ kind: "tag", id: TAG, name: "Exams" }} viewId="cal" canManage
      schemaFields={[{ name: "exam", type: "date", label: "Exam day" }, { name: "author", type: "text" }]} />);
    await screen.findByText("Algebra");
    fireEvent.click(screen.getByRole("button", { name: "View options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Date field…" }));
    const select = screen.getByRole("combobox", { name: "Date field" });
    // Date fields and the built-in dates; a text field is not a date.
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(["(automatic)", "Exam day", "Created date", "Last edited date"]);
    fireEvent.change(select, { target: { value: "exam" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(viewUpdates).toEqual([[{ kind: "tag", id: TAG }, "cal", { layout_config: { date_field: "exam" } }]]));
  });
});

describe("calendar view names its date field in plain words", () => {
  it("shows 建立時間 / 最後編輯日期, never created_at or updated_at", async () => {
    const original = view;
    try { for (const [field, label] of [["created_at", "Created date"], ["updated_at", "Last edited date"]] as const) {
      view = { ...original, layout_config: { date_field: field } };
      resetAppState();
      setAppState((s) => ({ data: { ...s.data, actor_role: "admin", actor_is_owner: true, workspace: { ...s.data.workspace, modules: null } } }));
      const { container, unmount } = render(<CollectionView source={{ kind: "tag", id: TAG, name: "Exams" }} viewId="cal" canManage />);
      await screen.findByText("Algebra");
      expect(container.querySelector(".cv-cal-field")).toHaveTextContent(label);
      expect(container.textContent).not.toMatch(/created_at|updated_at/);
      unmount();
    } } finally { view = original; }
  });
});
