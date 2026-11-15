// Dragging a note from the notes tree onto a tag row of the sidebar's tag list
// applies the tag (hooks/useSidebarDrag), with a drop highlight while held and
// an undo toast afterwards. The tag goes through the tag writer, the one path
// every membership change takes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []), upsertNode: vi.fn(async () => {}), removeNode: vi.fn(async () => {}), addPendingWrite: vi.fn(async () => {}) }));

import { useSidebarDrag } from "../hooks/useSidebarDrag";
import { noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { getAppState, resetAppState } from "../lib/appStore";
import { tagWriter } from "../lib/data";

const makeNode = (id: string, over: Partial<ContentNode> = {}): ContentNode => ({
  id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", parent_id: null, ...over,
});
const TAG: Tag = { id: "t-ideas", name: "ideas", color: "", schema_id: null };

function element(attrs: Record<string, string>) {
  const el = document.createElement("div");
  for (const [key, value] of Object.entries(attrs)) el.dataset[key] = value;
  el.getBoundingClientRect = () => ({ top: 0, bottom: 30, left: 0, right: 200, height: 30, width: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
  document.body.appendChild(el);
  return el;
}
function pointer(type: string, x: number, y: number) {
  window.dispatchEvent(new PointerEvent(type, { pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}

function setup(nodes: ContentNode[]) {
  resetAppState({ data: { ...noWorkspaceData, actor_is_owner: true, nodes, tags: [TAG] }, online: true });
  return renderHook(() => useSidebarDrag({ nodes, online: true, selectedNodeId: null, selectedNodeParentId: null })).result;
}
/** Press `node`'s row and drag past the 4px threshold, over whatever `over` is. */
function startDrag(result: ReturnType<typeof setup>, node: ContentNode, over: HTMLElement | null) {
  const row = element({ sbId: node.id, sbKind: "node" });
  document.elementFromPoint = (() => over) as typeof document.elementFromPoint;
  act(() => {
    result.current.onSbPointerDown(
      { button: 0, pointerType: "mouse", clientX: 10, clientY: 10, target: row, currentTarget: row, stopPropagation() {} } as unknown as React.PointerEvent,
      node, false,
    );
  });
  act(() => pointer("pointermove", 10, 60));
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (h: number) => clearTimeout(h));
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; vi.restoreAllMocks(); resetAppState(); });

describe("a note dropped on a tag row", () => {
  it("lights the row while held, applies the tag on release and offers an undo that removes it", async () => {
    const apply = vi.spyOn(tagWriter, "apply").mockResolvedValue(undefined as never);
    const remove = vi.spyOn(tagWriter, "remove").mockResolvedValue(undefined as never);
    const note = makeNode("n1", { title: "Sketch" });
    const result = setup([note]);
    startDrag(result, note, element({ sbTagId: TAG.id }));
    expect(result.current.sbTagDropId).toBe(TAG.id);
    expect(result.current.sbDropTarget).toBeNull();
    await act(async () => { pointer("pointerup", 10, 60); });
    expect(apply).toHaveBeenCalledWith("n1", TAG.id);
    expect(result.current.sbTagDropId).toBeNull();

    const toast = getAppState().toasts.at(-1)!;
    expect(toast).toMatchObject({ message: "Added #ideas", kind: "success" });
    expect(toast.action?.label).toBe("Undo");
    await act(async () => { toast.action!.onClick(); });
    expect(remove).toHaveBeenCalledWith("n1", TAG.id);
  });

  it("shows no target for a note that already has the tag, and a drop there changes nothing", async () => {
    const apply = vi.spyOn(tagWriter, "apply").mockResolvedValue(undefined as never);
    const note = makeNode("n1", { label_tag_ids: [TAG.id] });
    const result = setup([note]);
    startDrag(result, note, element({ sbTagId: TAG.id }));
    expect(result.current.sbTagDropId).toBeNull();
    await act(async () => { pointer("pointerup", 10, 60); });
    expect(apply).not.toHaveBeenCalled();
    expect(getAppState().toasts).toHaveLength(0);
  });

  it("does not tag a tag node, and releasing elsewhere does not tag", async () => {
    const apply = vi.spyOn(tagWriter, "apply").mockResolvedValue(undefined as never);
    const tagNode = makeNode("t-x", { node_type: "class_tag" });
    const first = setup([tagNode]);
    startDrag(first, tagNode, element({ sbTagId: TAG.id }));
    expect(first.current.sbTagDropId).toBeNull();
    await act(async () => { pointer("pointerup", 10, 60); });

    const note = makeNode("n2");
    const second = setup([note]);
    startDrag(second, note, null);
    await act(async () => { pointer("pointerup", 10, 60); });
    expect(apply).not.toHaveBeenCalled();
  });

  it("keeps the failure to the writer: a refused tag shows no 已加上 and no undo", async () => {
    vi.spyOn(tagWriter, "apply").mockRejectedValue(new Error("refused"));
    const note = makeNode("n1");
    const result = setup([note]);
    startDrag(result, note, element({ sbTagId: TAG.id }));
    await act(async () => { pointer("pointerup", 10, 60); });
    expect(getAppState().toasts.filter((toast) => toast.kind === "success")).toHaveLength(0);
  });
});
