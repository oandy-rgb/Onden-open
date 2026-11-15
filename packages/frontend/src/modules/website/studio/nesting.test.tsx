// What Puck 0.23 enforces for the home page's nesting rules, and what the
// studio enforces on top. Puck reads a slot's `allow` list from the static
// config only — one list per component type, whatever depth it sits at — so it
// cannot refuse an inner part inside an inner part. The Bridge undoes such a
// change, and the saved data stays valid. (Drag and drop itself needs a real
// pointer; these tests drive the same dispatch calls the drop makes.)
import "../../../test/puckEnv";
import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { PuckAction } from "@puckeditor/core";
import { INNER_SLOT_ALLOW, OUTER_SLOT_ALLOW, validateDesignV2, defaultDesignV2, type PuckComponentData, type PuckData } from "@onden/site";
import type { Prefill } from "./BlocksPanel";

const { Puck, createUsePuck } = await import("@puckeditor/core");
const { createStudioConfig } = await import("./studioConfig");
const { default: Bridge } = await import("./Bridge");
const { prefillOnAction } = await import("./prefill");
const { nestingViolation } = await import("./designModel");
const usePuck = createUsePuck();

type Api = { dispatch: (action: PuckAction) => void; content: PuckComponentData[] };
const api = {} as Api;
function Probe() {
  api.dispatch = usePuck((s) => s.dispatch) as Api["dispatch"];
  api.content = usePuck((s) => s.appState.data.content) as PuckComponentData[];
  return null;
}
const part = (type: string, id: string, extra: Record<string, unknown> = {}): PuckComponentData => ({ type, props: { id, bg: "none", heading: "auto", cls: "", css: "", ...extra } });
const note = (id: string): PuckComponentData => ({ type: "note", props: { id, noteId: "", blockId: "", display: "full" } });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });

async function mount(content: PuckComponentData[], prefill: Prefill = null) {
  const initial: PuckData = { root: { props: {} }, content };
  const onHome = vi.fn();
  const onRefuse = vi.fn();
  const dispatchRef = { current: null as ((action: PuckAction) => void) | null };
  const prefillRef = { current: prefill };
  render(
    <Puck config={createStudioConfig()} data={initial as never} iframe={{ enabled: false }} onAction={prefillOnAction(prefillRef, dispatchRef) as never}>
      <Bridge initial={initial} onHome={onHome} onRefuse={onRefuse} dispatchRef={dispatchRef} />
      <Puck.Preview /><Probe />
    </Puck>,
  );
  await settle();
  return { onHome, onRefuse, prefillRef };
}
const insert = async (componentType: string, destinationZone: string, destinationIndex = 0) => {
  await act(async () => { api.dispatch({ type: "insert", componentType, destinationZone, destinationIndex }); });
  await settle();
};

describe("what Puck knows about nesting", () => {
  it("has one slot allow list per component type, and resolveFields does not change it", () => {
    const config = createStudioConfig();
    const stackItems = (config.components.stack!.fields as Record<string, { allow?: string[] }>).items!;
    // The outer list: content and inner parts. An inner stack gets the same list from Puck.
    expect(stackItems.allow).toEqual([...OUTER_SLOT_ALLOW]);
    expect(stackItems.allow).toContain("stack");
    expect((config.components.stack as { resolveFields?: unknown }).resolveFields).toBeUndefined();
    const pattern = (config.components.pattern_work_cards!.fields as Record<string, { allow?: string[] }>).items!;
    expect(pattern.allow).toEqual([...INNER_SLOT_ALLOW]);
  });
});

describe("the studio keeps the saved data valid", () => {
  it("opening does not count as a change (Puck reorders keys on load)", async () => {
    const { onHome } = await mount([part("stack", "s", { items: [note("n")] })]);
    expect(onHome).not.toHaveBeenCalled();
  });
  it("accepts content in a part and reports it as the new page", async () => {
    const { onHome, onRefuse } = await mount([part("stack", "s", { items: [] })]);
    await insert("note", "s:items");
    expect(onRefuse).not.toHaveBeenCalled();
    const home = onHome.mock.calls.at(-1)![0] as PuckData;
    expect((home.content[0]!.props.items as PuckComponentData[]).map((c) => c.type)).toEqual(["note"]);
    expect(validateDesignV2({ ...defaultDesignV2({}), home }).problems).toEqual([]);
  });
  it("an inner part inside an inner part is undone, with the 「這裡不能放零件」 refusal", async () => {
    const { onHome, onRefuse } = await mount([part("stack", "s", { items: [part("cards", "c", { items: [] })] })]);
    await insert("stack", "c:items");
    expect(onRefuse).toHaveBeenCalled();
    expect(nestingViolation({ root: { props: {} }, content: api.content })).toBeNull();
    expect((api.content[0]!.props.items as PuckComponentData[])[0]!.props.items).toEqual([]);
    for (const [home] of onHome.mock.calls) expect(nestingViolation(home as PuckData)).toBeNull();
  });
  it("a top-level-only part inside a part is undone", async () => {
    const { onRefuse } = await mount([part("stack", "s", { items: [] })]);
    await insert("sidebar", "s:items");
    expect(onRefuse).toHaveBeenCalled();
    expect(api.content[0]!.props.items).toEqual([]);
  });
  it("a template inside a part is undone", async () => {
    const { onRefuse } = await mount([part("stack", "s", { items: [] })]);
    await insert("pattern_work_cards", "s:items");
    expect(onRefuse).toHaveBeenCalled();
  });
  it("content dropped on the top level stays there, with no stack around it", async () => {
    const { onHome, onRefuse } = await mount([part("stack", "s", { items: [] })]);
    await insert("note", "root:default-zone", 1);
    expect(onRefuse).not.toHaveBeenCalled();
    expect(api.content.map((c) => c.type)).toEqual(["stack", "note"]);
    const home = onHome.mock.calls.at(-1)![0] as PuckData;
    expect(nestingViolation(home)).toBeNull();
    expect(validateDesignV2({ ...defaultDesignV2({}), home }).design.home.content.map((c) => c.type)).toEqual(["stack", "note"]);
  });
  it("a layout inside a layout is still undone, beside top-level content", async () => {
    const { onRefuse } = await mount([part("stack", "s", { items: [part("cards", "c", { items: [] })] }), note("n")]);
    await insert("cards", "c:items");
    expect(onRefuse).toHaveBeenCalled();
    expect(api.content.map((c) => c.type)).toEqual(["stack", "note"]);
  });
});

describe("dragging a note or tag from the drawer", () => {
  it("the new component has the chosen note", async () => {
    const { onHome, prefillRef } = await mount([part("stack", "s", { items: [] })], { type: "note", props: { noteId: "alpha" } });
    await insert("note", "s:items");
    expect(prefillRef.current).toBeNull();
    const home = onHome.mock.calls.at(-1)![0] as PuckData;
    expect((home.content[0]!.props.items as PuckComponentData[])[0]!.props).toMatchObject({ noteId: "alpha", display: "full" });
  });
  it("the new tag view has the chosen tag", async () => {
    const { onHome } = await mount([part("stack", "s", { items: [] })], { type: "tag_view", props: { tagId: "tA" } });
    await insert("tag_view", "s:items");
    const home = onHome.mock.calls.at(-1)![0] as PuckData;
    expect((home.content[0]!.props.items as PuckComponentData[])[0]!.props).toMatchObject({ tagId: "tA", viewKind: "list" });
  });
  it("on the top level the choice is on the note itself", async () => {
    const { onHome } = await mount([], { type: "note", props: { noteId: "alpha" } });
    await insert("note", "root:default-zone", 0);
    const home = onHome.mock.calls.at(-1)![0] as PuckData;
    expect(home.content.map((c) => c.type)).toEqual(["note"]);
    expect(home.content[0]!.props.noteId).toBe("alpha");
  });
  it("a choice belongs to one insert: a later plain insert is not pre-filled", async () => {
    const { onHome } = await mount([part("stack", "s", { items: [] })], { type: "note", props: { noteId: "alpha" } });
    await insert("tag_view", "s:items");
    await insert("note", "s:items", 1);
    const items = (onHome.mock.calls.at(-1)![0] as PuckData).content[0]!.props.items as PuckComponentData[];
    expect(items.map((c) => c.props.noteId ?? c.props.tagId)).toEqual(["", ""]);
  });
});
