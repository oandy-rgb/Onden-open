// The pen presets: the pure list rules (lib/ink/presets) and the toolbar's
// button — save the current pen, bring one back with a tap, rename, delete,
// the limit of six — and that they follow the account (lib/inkPrefs).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { INK_PRESET_NAME_MAX } from "@onden/markdown";

let serverPrefs: Record<string, unknown> = {};
const sendWrite = vi.hoisted(() => vi.fn());
vi.mock("../lib/data/onlineWrite", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/data/onlineWrite")>(), sendWrite }));
vi.mock("../lib/data/reads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/data/reads")>();
  return { ...real, reads: { ...real.reads, people: { ...real.reads.people, myPref: vi.fn(async (key: string) => ({ value: serverPrefs[key] ?? null })) } } };
});

import InkToolbar from "../components/InkToolbar";
import { useInkPen } from "../hooks/useInkPen";
import { bindAccountStorage } from "../lib/accountStorage";
import { inkPresetsPref } from "../lib/inkPrefs";
import {
  MAX_PRESETS, parsePresets, presetMatches, withPreset, withPresetName, withoutPreset, type InkPreset,
} from "../lib/ink";
import type { InkActiveTool } from "../lib/ink";

const preset = (id: string, over: Partial<InkPreset> = {}): InkPreset => ({ id, name: "", tool: "pen", color: "#15130d", sizeId: "medium", ...over });

describe("the preset list", () => {
  it("keeps good entries in order and drops bad ones, a repeated id and any past six", () => {
    const seven = Array.from({ length: 7 }, (_, i) => preset(`p${i}`));
    expect(parsePresets(seven)!.map((p) => p.id)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);
    expect(parsePresets([preset("a"), preset("a", { color: "#ffffff" })])).toHaveLength(1);
    expect(parsePresets([preset("a"), { id: "b", tool: "eraser", color: "#000000", sizeId: "fine", name: "" }, { id: "c", tool: "pen", color: "red", sizeId: "fine" }, null, 3])).toHaveLength(1);
    expect(parsePresets("nope")).toBeNull();
    expect(parsePresets({})).toBeNull();
    expect(parsePresets([])).toEqual([]);
  });

  it("colours are stored as #rrggbb; a name is cut by characters, never in the middle of one", () => {
    const [kept] = parsePresets([preset("a", { color: "#ABC", name: "👨‍👩‍👧".repeat(INK_PRESET_NAME_MAX + 3) })])!;
    expect(kept!.color).toBe("#aabbcc");
    expect([...new Intl.Segmenter().segment(kept!.name)]).toHaveLength(INK_PRESET_NAME_MAX);
    expect(withPresetName([preset("a")], "a", `  ${"字".repeat(40)}  `)[0]!.name).toBe("字".repeat(INK_PRESET_NAME_MAX));
  });

  it("adding stops at six; removing and renaming touch only their entry", () => {
    let list: InkPreset[] = [];
    for (let i = 0; i < 9; i++) list = withPreset(list, preset(`p${i}`));
    expect(list).toHaveLength(MAX_PRESETS);
    expect(withoutPreset(list, "p2").map((p) => p.id)).toEqual(["p0", "p1", "p3", "p4", "p5"]);
    expect(withPresetName(list, "p1", " 批註 ").map((p) => p.name)).toEqual(["", "批註", "", "", "", ""]);
  });

  it("the pen is a preset when tool, colour (any case) and thickness all match", () => {
    const p = preset("a", { tool: "highlighter", color: "#fff176", sizeId: "broad" });
    expect(presetMatches(p, { tool: "highlighter", color: "#FFF176", sizeId: "broad" })).toBe(true);
    expect(presetMatches(p, { tool: "pen", color: "#fff176", sizeId: "broad" })).toBe(false);
    expect(presetMatches(p, { tool: "highlighter", color: "#fff176", sizeId: "fine" })).toBe(false);
  });
});

beforeEach(() => {
  localStorage.clear();
  serverPrefs = {};
  sendWrite.mockReset().mockImplementation(async (_m: string, path: string, body: { value: unknown }) => {
    serverPrefs[path.split("/").pop()!] = body.value;
    return { value: body.value };
  });
  bindAccountStorage("ink-presets-test", "");
  inkPresetsPref.store.forget();
});
afterEach(() => cleanup());

function Host({ onTool }: { onTool?: (t: InkActiveTool) => void }) {
  const pen = useInkPen({ color: "#15130d", sizeId: "medium" });
  const [tool, setTool] = useState<InkActiveTool>("pen");
  return (
    <>
      <InkToolbar
        tool={tool}
        onToolChange={(t) => { setTool(t as InkActiveTool); onTool?.(t as InkActiveTool); }}
        {...pen.toolbar}
        canUndo={false} canRedo={false} onUndo={() => {}} onRedo={() => {}}
      />
      <output data-testid="pen">{`${tool} ${pen.color} ${pen.toolbar.sizeId}`}</output>
    </>
  );
}
const pen = () => screen.getByTestId("pen").textContent;
const puts = () => sendWrite.mock.calls.filter(([m, p]) => m === "PUT" && p === "/api/me/prefs/inkPresets").map(([, , body]) => body.value as InkPreset[]);
const openList = () => fireEvent.click(screen.getByRole("button", { name: "Pen presets" }));
const panel = () => screen.getByRole("dialog", { name: "Pen presets" });
const rows = () => [...panel().querySelectorAll("[data-ink-preset]")];

describe("the presets button", () => {
  it("is one button on the toolbar; an empty list says how to start", () => {
    render(<Host />);
    openList();
    expect(rows()).toHaveLength(0);
    expect(within(panel()).getByText("No presets yet. Set up a pen, then save it here.")).toBeTruthy();
  });

  it("saves the current pen (tool, colour, thickness), and a tap on it brings that pen back", async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Highlighter" }));
    fireEvent.click(screen.getByRole("button", { name: "Broad" }));
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    openList();
    fireEvent.click(screen.getByText("Save the current pen as a preset"));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual([expect.objectContaining({ name: "", tool: "highlighter", color: "#c43c3c", sizeId: "broad" })]);
    expect(rows()[0]!.textContent).toContain("Highlighter · Broad");

    // change everything, then use the preset
    fireEvent.keyDown(panel(), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Pen" }));
    fireEvent.click(screen.getByRole("button", { name: "Fine" }));
    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    expect(pen()).toBe("pen #315f8f fine");
    openList();
    fireEvent.click(rows()[0]!.querySelector(".ink-preset-use")!);
    expect(pen()).toBe("highlighter #c43c3c broad");
    expect(screen.queryByRole("dialog", { name: "Pen presets" })).toBeNull(); // one tap, done
  });

  it("the row of the pen in use is marked", async () => {
    render(<Host />);
    openList();
    fireEvent.click(screen.getByText("Save the current pen as a preset"));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]!.querySelector(".ink-preset-use")!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(panel(), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    openList();
    expect(rows()[0]!.querySelector(".ink-preset-use")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("the ⋯ button renames (Enter saves) and deletes", async () => {
    render(<Host />);
    openList();
    fireEvent.click(screen.getByText("Save the current pen as a preset"));
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Rename or delete preset" }));
    const input = screen.getByRole("textbox", { name: "Preset name" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "批註" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(puts().at(-1)![0]!.name).toBe("批註"));
    expect(rows()[0]!.textContent).toContain("批註");
    fireEvent.click(screen.getByRole("button", { name: "Rename or delete preset" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete preset" }));
    await waitFor(() => expect(puts().at(-1)).toEqual([]));
    expect(rows()).toHaveLength(0);
  });

  it("Esc while renaming only ends the rename (the list stays open), and an IME's Enter does not save", async () => {
    render(<Host />);
    openList();
    fireEvent.click(screen.getByText("Save the current pen as a preset"));
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Rename or delete preset" }));
    const input = screen.getByRole("textbox", { name: "Preset name" });
    fireEvent.change(input, { target: { value: "ㄅ" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(screen.getByRole("textbox", { name: "Preset name" })).toBeTruthy(); // still editing
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Preset name" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Pen presets" })).toBeTruthy();
  });

  it("the seventh cannot be saved: the button says so and is off", async () => {
    serverPrefs.inkPresets = Array.from({ length: MAX_PRESETS }, (_, i) => preset(`p${i}`, { name: `預設${i}` }));
    render(<Host />);
    openList();
    await waitFor(() => expect(rows()).toHaveLength(MAX_PRESETS));
    const save = panel().querySelector("[data-ink-preset-save]") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.textContent).toContain(`Up to ${MAX_PRESETS} presets`);
  });

  it("the presets follow the account: another device's list arrives", async () => {
    serverPrefs.inkPresets = [preset("x", { name: "考卷", tool: "pen", color: "#315f8f", sizeId: "fine" })];
    render(<Host />);
    openList();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]!.textContent).toContain("考卷");
  });

  it("with the eraser on, saving keeps a pen (the eraser has no colour or thickness)", async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Eraser" }));
    openList();
    fireEvent.click(screen.getByText("Save the current pen as a preset"));
    await waitFor(() => expect(puts()[0]).toEqual([expect.objectContaining({ tool: "pen" })]));
  });
});
