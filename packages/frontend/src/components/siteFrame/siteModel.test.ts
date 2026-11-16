import { describe, expect, it } from "vitest";
import { defaultFrames, type SiteRow } from "@onden/site";
import { adjacentNotes, backlinksOf, coverImage, noteDate, noteTree, readSiteData, showsDate, usesDiagrams } from "./siteModel";
import { sortChildren } from "../../lib/childOrder";
import type { PublishedNode } from "../templates/publishedCore";

const rowOf = (id: string, extra: Partial<SiteRow> = {}): SiteRow => ({ id, title: id, slug: id, date: "", fields: {}, image: "", excerpt: "", ...extra });
const n = (id: string, extra: Partial<PublishedNode> = {}): PublishedNode =>
  ({ id, node_type: "content", title: id, slug: id, markdown: `# ${id}`, ...extra });

describe("readSiteData", () => {
  it("a snapshot without a design gets the default design (簡單) and empty publish-time rows", () => {
    const data = readSiteData({ title: "T", home_node_id: "h", payload: { nodes: [n("h")], presentation: { site: { brand: "B" } } } });
    expect(data.design.v).toBe(3);
    expect(data.design.preset).toBe("simple");
    expect(data.design.legacy_home).toBeNull();
    expect(data.design.resolved).toEqual({});
    expect(data.design.tag_pages).toEqual({});
    expect(data.design.date_tags).toEqual(["文章"]);
  });
});

describe("page helpers", () => {
  const design = readSiteData({ payload: { nodes: [], presentation: {} } }).design;

  it("a date shows only for notes with a date tag", () => {
    expect(showsDate({ tags: ["文章"] }, ["文章"])).toBe(true);
    expect(showsDate({ tags: ["日記"] }, ["文章"])).toBe(false);
    expect(showsDate({}, ["文章"])).toBe(false);
  });

  it("the date comes from the publish-time row, else the creation day in the site's zone", () => {
    const note = n("a", { created_at: "2026-02-03T20:00:00Z" });
    expect(noteDate(note, design, "Asia/Taipei")).toBe("2026-02-04");
    const withRow = { ...design, resolved: { x: [rowOf("a", { date: "2025-12-31" })] } };
    expect(noteDate(note, withRow, "Asia/Taipei")).toBe("2025-12-31");
    expect(noteDate(n("b"), design)).toBeNull();
  });

  it("a page made in the small hours is dated the day before when the workspace's day starts later", () => {
    const note = n("a", { created_at: "2026-02-03T18:30:00Z" }); // 02:30 on the 4th in Taipei
    expect(noteDate(note, design, "Asia/Taipei", 0)).toBe("2026-02-04");
    expect(noteDate(note, design, "Asia/Taipei", 4)).toBe("2026-02-03");
  });

  it("previous/next: siblings first, then the first tag page's order", () => {
    const nodes = [n("p"), n("a", { parent_id: "p", order_key: "a1" }), n("b", { parent_id: "p", order_key: "a2" }), n("c", { parent_id: "p", order_key: "a3" })];
    expect(adjacentNotes(nodes[2]!, nodes, design)).toMatchObject({ prev: { id: "a" }, next: { id: "c" } });
    const solo = n("solo", { tags: ["T"] });
    const tagged = { ...design, tag_pages: { t: { name: "T", slug: "t", viewKind: "list" as const, rows: [rowOf("x"), rowOf("solo")] } } };
    const all = [solo, n("x")];
    expect(adjacentNotes(solo, all, tagged)).toMatchObject({ prev: { id: "x" }, next: null });
    expect(adjacentNotes(n("alone"), [n("alone")], design)).toEqual({ prev: null, next: null });
  });

  it("siblings come in the app's order: ties on the key go by stamp then id, never by title", () => {
    const kids = [
      n("c", { parent_id: "p", title: "Alpha", order_key: "a0", created_at: "2026-10-03T00:00:00Z" }),
      n("a", { parent_id: "p", title: "Zulu", order_key: "a0", created_at: "2026-10-01T00:00:00Z" }),
      n("b", { parent_id: "p", title: "Mid", order_key: "a0", created_at: "2026-10-02T00:00:00Z" }),
    ];
    const nodes = [n("p"), ...kids];
    const appOrder = sortChildren(kids).map((k) => k.id);
    expect(appOrder).toEqual(["a", "b", "c"]);
    expect(adjacentNotes(kids[2]!, nodes, design)).toMatchObject({ prev: { id: "a" }, next: { id: "c" } });
    expect(noteTree(nodes)[0]!.children.map((c) => c.node.id)).toEqual(appOrder);
  });

  it("backlinks are the other published notes that link here, once each", () => {
    const nodes = [n("a"), n("b"), n("c")];
    const edges = [
      { source_node_id: "b", target_node_id: "a", edge_type: "knowledge_link" as const },
      { source_node_id: "b", target_node_id: "a", edge_type: "nav_link" as const },
      { source_node_id: "gone", target_node_id: "a", edge_type: "knowledge_link" as const },
      { source_node_id: "a", target_node_id: "a", edge_type: "knowledge_link" as const },
    ];
    expect(backlinksOf(nodes[0]!, nodes, edges).map((x) => x.node.id)).toEqual(["b"]);
  });

  it("the tree nests by parent and a note whose parent is not published is a root", () => {
    const tree = noteTree([n("r"), n("k", { parent_id: "r" }), n("orphan", { parent_id: "missing" })]);
    expect(tree.map((t) => t.node.id).sort()).toEqual(["orphan", "r"]);
    expect(tree.find((t) => t.node.id === "r")!.children.map((c) => c.node.id)).toEqual(["k"]);
  });

  it("cover image is the first image as written", () => {
    expect(coverImage("text ![a](/api/media/1.png) ![b](/api/media/2.png)")).toBe("/api/media/1.png");
    expect(coverImage("no image")).toBeUndefined();
  });

  it("defaultFrames has every article switch", () => {
    expect(Object.keys(defaultFrames().article)).toContain("prevnext");
  });
});

describe("usesDiagrams", () => {
  it("is true only for a mermaid fence, not for a mention of one", () => {
    expect(usesDiagrams([n("a", { markdown: "# a\n\n```mermaid\ngraph TD; A-->B;\n```" })])).toBe(true);
    expect(usesDiagrams([n("a", { markdown: "~~~mermaid\nx\n~~~" })])).toBe(true);
    expect(usesDiagrams([n("a", { markdown: "write ```mermaid in a fence" })])).toBe(false);
    expect(usesDiagrams([n("a", { markdown: "```js\nconst mermaid = 1\n```" })])).toBe(false);
    expect(usesDiagrams([])).toBe(false);
  });

  it("is false once every fence has a layout from publish time, true while one still needs the script", () => {
    const covered = new Map([["graph TD; A-->B;", {}]]);
    const note = n("a", { markdown: "```mermaid\ngraph TD; A-->B;\n```" });
    expect(usesDiagrams([note], covered)).toBe(false);
    expect(usesDiagrams([n("a", { markdown: "```mermaid\ngraph TD; A-->B;\n```\n\n```mermaid\ngraph TD; X-->Y;\n```" })], covered)).toBe(true);
  });

  it("readSiteData keeps only diagrams that check out against their own block", () => {
    const source = "flowchart TD\n  A[Start] --> B[Go]";
    const good = { version: 1, kind: "flowchart", width: 100, height: 100, groups: [], edges: [], nodes: [{ id: "A", shape: "rect", x: 1, y: 1, w: 10, h: 10, label: "Start" }] };
    const forged = { ...good, nodes: [{ ...good.nodes[0], label: "<script>x</script>" }] };
    const data = readSiteData({ payload: { nodes: [], edges: [], diagrams: [{ source, layout: good }, { source: `${source}\n`, layout: forged }, "junk"] } });
    expect([...data.diagrams.keys()]).toEqual([source]);
  });
});
