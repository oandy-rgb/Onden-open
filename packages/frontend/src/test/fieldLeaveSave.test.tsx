// A field whose text is saved on blur/Enter must also save it when the person leaves without a blur:
// the component unmounts (note switch, sheet closed) or the page goes away (tab closed, app killed).
// The save always goes to the target the text was typed on, never "the current one".
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NodeProps } from "@xyflow/react";
import { setAppState } from "../lib/appStore";

vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []), getNodeAttributeRecord: vi.fn(async () => null), upsertAttribute: vi.fn(async () => {}), removeAttribute: vi.fn(async () => {}) }));
const apiMock = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => ({}));
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: (path: string, init?: RequestInit) => apiMock(path, init) };
});
const flow = vi.hoisted(() => ({ zoom: 1 }));
vi.mock("@xyflow/react", () => ({
  useUpdateNodeInternals: () => () => {},
  useStore: (select: (s: { transform: number[] }) => number) => select({ transform: [0, 0, flow.zoom] }),
  NodeResizer: () => null, Handle: () => null, Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));
vi.mock("../hooks/useToday", () => ({ useToday: () => "2026-10-29" }));

import { TextValueField } from "../components/attributes/TextValueField";
import TableLayout from "../modules/table/TableLayout";
import TagDescription from "../components/TagDescription";
import TaskSheet from "../modules/tasks/TaskSheet";
import { SectionNode } from "../components/SectionNode";
import { GraphCallbacksContext } from "../components/graphCallbacks";
import type { ExecResponse } from "../lib/viewExec";
import type { TaskItem } from "../lib/tasks";

beforeEach(() => { setAppState({ online: true }); apiMock.mockClear(); apiMock.mockResolvedValue({}); });
afterEach(() => { cleanup(); });

const hide = () => act(() => { window.dispatchEvent(new Event("pagehide")); });
const hiddenTab = () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
};
const leaves = [
  ["unmounts", (view: { unmount: () => void }) => act(() => view.unmount())],
  ["the page is hidden", () => hide()],
  ["the app goes to the background", () => hiddenTab()],
] as const;

const exec = (): ExecResponse => ({
  rows: [{ id: "node-1", title: "Widget", slug: "widget", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", attributes: { note: "" } }],
  total: 1, next: null, view: { layout: "table", group_by: null, visible_fields: ["title", "note"], layout_config: {} },
});
const task = (): TaskItem => ({
  id: "t1", title: "Write", status: "todo", source: "standalone", noteId: null, noteTitle: "",
  whenDate: null, evening: false, someday: false, deadline: null, recur: null, recurMode: "fixed", remindAt: null, hasBody: false,
} as TaskItem);

it.each(leaves)("attribute text: typed text is saved when %s", (_name, leave) => {
  const onSave = vi.fn();
  const view = render(<TextValueField field={{ type: "text" }} label="Topic" value="Old" onSave={onSave} />);
  const input = screen.getByRole("textbox");
  fireEvent.focus(input); fireEvent.change(input, { target: { value: "Typed" } });
  leave(view);
  expect(onSave).toHaveBeenCalledExactlyOnceWith("Typed");
});

it.each(leaves)("table cell: typed text is saved to its own row and column when %s", async (_name, leave) => {
  const view = render(<TableLayout exec={exec()} />);
  fireEvent.click(screen.getByTitle("Click to edit"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "typed" } });
  leave(view);
  await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
  expect(apiMock.mock.calls[0]![0]).toBe("/api/nodes/node-1/attributes/note");
  expect(JSON.parse(apiMock.mock.calls[0]![1]!.body as string)).toMatchObject({ value: "typed" });
});

it.each(leaves)("tag description: typed text is saved when %s", (_name, leave) => {
  const onSave = vi.fn();
  const view = render(<TagDescription markdown="Old" canEdit onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit the description" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Typed" } });
  leave(view);
  expect(onSave).toHaveBeenCalledExactlyOnceWith("Typed", "Old");
});

it.each(leaves)("task title: typed text is saved when %s", (_name, leave) => {
  const change = vi.fn();
  const view = render(<TaskSheet task={task()} today="2026-10-29" notes={[]} actions={{ change, complete() {}, openNote() {}, openBody() {}, remove() {}, drop() {} }} onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), { target: { value: "Write more" } });
  leave(view);
  expect(change).toHaveBeenCalledExactlyOnceWith(expect.anything(), { title: "Write more" });
});

it.each(leaves)("board group name: typed text is saved when %s", (_name, leave) => {
  const save = vi.fn();
  const props = { id: "section-s", data: { sectionId: "s", title: "Before", cardCount: 2 }, selected: false } as unknown as NodeProps;
  const view = render(<GraphCallbacksContext.Provider value={{ onSectionTitleChange: save } as never}><SectionNode {...props} /></GraphCallbacksContext.Provider>);
  const input = screen.getByRole("textbox");
  fireEvent.focus(input); fireEvent.change(input, { target: { value: "After" } });
  leave(view);
  expect(save).toHaveBeenCalledExactlyOnceWith("s", "After");
});

it("attribute text, wrong note: text typed on note A goes to note A; a blur on note B writes nothing into B", () => {
  const saveA = vi.fn(), saveB = vi.fn();
  const field = (scope: string, value: string, onSave: typeof saveA) => <TextValueField field={{ type: "text" }} label="Topic" value={value} onSave={onSave} scope={scope} />;
  const { rerender } = render(field("note-a", "A text", saveA));
  const input = screen.getByRole("textbox");
  fireEvent.focus(input); fireEvent.change(input, { target: { value: "typed on A" } });
  // A keyboard note switch: the same box, still focused, now belongs to note B.
  rerender(field("note-b", "B text", saveB));
  expect(saveA).toHaveBeenCalledExactlyOnceWith("typed on A");
  expect(screen.getByRole("textbox")).toHaveValue("B text");
  fireEvent.blur(screen.getByRole("textbox"));
  hide();
  expect(saveB).not.toHaveBeenCalled();
  expect(saveA).toHaveBeenCalledTimes(1);
});
