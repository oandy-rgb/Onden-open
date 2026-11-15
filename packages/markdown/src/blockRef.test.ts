import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { noteHasBlock } from "./blockRef.js";
import { chooseBlockHome, servedBlockTarget, type BlockServedPage } from "./blockHome.js";

// A served page carries the ids of its anchors (`block_ids`); its text holds no `^id`.
const page = (id: string, title: string, markdown: string, extra: Partial<BlockServedPage> = {}): BlockServedPage =>
  ({ id, title, slug: title.toLowerCase(), markdown, block_ids: [], ...extra });

describe("noteHasBlock", () => {
  it("sees an anchor's id, not text that merely mentions one", () => {
    expect(noteHasBlock(["k1"], "k1")).toBe(true);
    expect(noteHasBlock(new Set(["k1", "k3"]), "k3")).toBe(true);
    expect(noteHasBlock(["k1"], "k2")).toBe(false);
    expect(noteHasBlock([], "k1")).toBe(false);
  });
});

describe("chooseBlockHome", () => {
  const c = (underNamed: boolean, sameSpace: boolean, tag = "") => ({ underNamed, sameSpace, tag });
  it("none → null, one → it", () => {
    expect(chooseBlockHome([])).toBeNull();
    expect(chooseBlockHome([c(false, false, "x")])?.tag).toBe("x");
  });
  it("prefers the descendants of A, then A's space, else gives up", () => {
    expect(chooseBlockHome([c(false, true, "same"), c(true, false, "child")])?.tag).toBe("child");
    expect(chooseBlockHome([c(false, true, "same"), c(false, false, "other")])?.tag).toBe("same");
    expect(chooseBlockHome([c(false, true), c(false, true)])).toBeNull();
    expect(chooseBlockHome([c(true, true), c(true, false), c(false, true)])?.tag).toBe("");
    expect(chooseBlockHome([c(false, false), c(false, false)])).toBeNull();
  });
  it("is independent of candidate order, and never invents a candidate", () => {
    fc.assert(fc.property(fc.array(fc.record({ underNamed: fc.boolean(), sameSpace: fc.boolean() }), { maxLength: 6 }), (list) => {
      const tagged = list.map((x, i) => ({ ...x, i }));
      const picked = chooseBlockHome(tagged);
      const reversed = chooseBlockHome([...tagged].reverse());
      expect(picked?.i ?? null).toBe(reversed?.i ?? null);
      if (picked) expect(tagged).toContain(picked);
      if (picked && tagged.some((x) => x.underNamed)) expect(picked.underNamed).toBe(true);
    }));
  });
});

describe("servedBlockTarget (the published site)", () => {
  const A = page("a", "Alpha", "Nothing here");
  const B = page("b", "Beta", "Moved paragraph", { block_ids: ["p1"] });
  it("uses the named page when it holds the block", () => {
    const withBlock = page("a", "Alpha", "Here", { block_ids: ["p1"] });
    expect(servedBlockTarget("Alpha#^p1", [withBlock, B])?.page.id).toBe("a");
  });
  it("falls back to the one other page holding it", () => {
    expect(servedBlockTarget("Alpha#^p1", [A, B])).toMatchObject({ page: { id: "b" }, named: { id: "a" } });
  });
  it("keeps the named page when nobody holds it, or several do", () => {
    expect(servedBlockTarget("Alpha#^zz", [A, B])?.page.id).toBe("a");
    const C = page("c", "Gamma", "Pasted", { block_ids: ["p1"] });
    expect(servedBlockTarget("Alpha#^p1", [A, B, C])?.page.id).toBe("a");
  });
  it("ranks pages under the named one first", () => {
    const C = page("c", "Gamma", "Pasted", { block_ids: ["p1"] });
    const child = page("b", "Beta", "Moved", { parent_id: "a", block_ids: ["p1"] });
    expect(servedBlockTarget("Alpha#^p1", [A, C, child])?.page.id).toBe("b");
  });
  it("is the plain link without a block id or a named page", () => {
    expect(servedBlockTarget("Alpha", [A, B])?.page.id).toBe("a");
    expect(servedBlockTarget("Nope#^p1", [A, B])).toBeNull();
  });
  it("a `^id` in a page's text is not an anchor; only block_ids count", () => {
    const texty = page("c", "Gamma", "Mentions ^p1");
    expect(servedBlockTarget("Alpha#^p1", [A, texty])?.page.id).toBe("a");
  });
  it("a named page without block_ids (anchors unknown) is kept", () => {
    const unknown: BlockServedPage = { id: "a", title: "Alpha", slug: "alpha", markdown: "Nothing here" };
    expect(servedBlockTarget("Alpha#^p1", [unknown, B])?.page.id).toBe("a");
  });
  it("does not search pages that are not in the served list", () => {
    expect(servedBlockTarget("Alpha#^p1", [A])?.page.id).toBe("a");
  });
});
