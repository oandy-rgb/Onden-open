// The part-link reading is not in the app's first JS (lib/partLinkModule): a note with no such link never loads it, a note
// with one draws the link as written at once and as 「筆記 › 開頭」 as soon as the module is here.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(() => { cleanup(); vi.resetModules(); });

const meal = { id: "n1", title: "吃飯紀錄", slug: "n1", markdown: "17:45 吃飯很久\n", source_type: "manual", node_type: "content", space_id: "s" };
const source = { id: "n2", title: "來源", slug: "n2", markdown: "", source_type: "manual", node_type: "content", space_id: "s" };

async function fresh() {
  vi.resetModules();
  const { default: MarkdownRenderer } = await import("../components/MarkdownRenderer");
  const mod = await import("../lib/partLinkModule");
  return { MarkdownRenderer, mod };
}

describe("the part-link module loads on use", () => {
  it("a note with no such link does not load it", async () => {
    const { MarkdownRenderer, mod } = await fresh();
    render(<MarkdownRenderer nodes={[meal, source] as never} from={source as never} onNavigate={vi.fn()}>{"plain [[吃飯紀錄]] and text"}</MarkdownRenderer>);
    await new Promise((r) => setTimeout(r, 20));
    expect(mod.loadedPartLinks()).toBeNull();
    expect(screen.getByRole("button", { name: "吃飯紀錄" })).toBeTruthy();
  });

  it("a note with one reads the link as written first, then as 「筆記 › 開頭」", async () => {
    const { MarkdownRenderer, mod } = await fresh();
    render(<MarkdownRenderer nodes={[meal, source] as never} from={source as never} onNavigate={vi.fn()}>{"[[吃飯紀錄/17:45]]"}</MarkdownRenderer>);
    expect(mod.loadedPartLinks()).toBeNull();
    expect(await screen.findByRole("button", { name: "吃飯紀錄 › 17:45 吃飯很久" })).toBeTruthy();
    expect(mod.loadedPartLinks()).not.toBeNull();
  });

  it("what may hold a link is a cheap guess from the text: [[ ]] with a / or a #^ somewhere", async () => {
    const { mod } = await fresh();
    expect(mod.mayHavePartLinks("see [[a/b]]")).toBe(true);
    expect(mod.mayHavePartLinks("see ![[a/b]]")).toBe(true);
    expect(mod.mayHavePartLinks("see [[a#^k1]]")).toBe(true);
    expect(mod.mayHavePartLinks("see [[a]] and plain words")).toBe(false);
    expect(mod.mayHavePartLinks("no links, a/b")).toBe(false);
  });
});
