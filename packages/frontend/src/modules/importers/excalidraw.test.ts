import { describe, expect, it } from "vitest";
import { compressToBase64 } from "lz-string";
import { decodeExcalidraw, isExcalidrawFile, withoutPluginFrontmatter } from "./excalidraw";
import { decodeInk, encodeInk } from "@onden/markdown/ink";

// An Obsidian Excalidraw note becomes a handwriting page: freehand strokes
// keep their points (offset by x/y), pressure, colour and width; lines and
// arrows become strokes; what can't be drawn is reported, not dropped.
const scene = {
  type: "excalidraw", version: 2, source: "obsidian",
  elements: [
    { id: "f1", type: "freedraw", x: 100, y: 50, width: 20, height: 10, angle: 0, strokeColor: "#e03131", strokeWidth: 2,
      points: [[0, 0], [10, 5], [20, 10]], pressures: [0.2, 0.5, 0.8], simulatePressure: false, isDeleted: false },
    { id: "gone", type: "freedraw", x: 0, y: 0, points: [[0, 0], [5, 5]], isDeleted: true },
    { id: "f2", type: "freedraw", x: 120, y: 60, strokeWidth: 1, points: [[0, 0], [4, 4]], pressures: [], simulatePressure: true },
    { id: "a1", type: "arrow", x: 100, y: 100, strokeColor: "#1e1e1e", strokeWidth: 2, points: [[0, 0], [50, 0]] },
    { id: "l1", type: "line", x: 100, y: 120, strokeWidth: 1, points: [[0, 0], [0, 30]] },
    { id: "img", type: "image", x: 0, y: 0, fileId: "abc" },
    { id: "fr", type: "frame", x: 0, y: 0 },
    { id: "t1", type: "text", x: 0, y: 0, text: "Label", originalText: "Label" },
  ],
  appState: { viewBackgroundColor: "#ffffff" }, files: {},
};

const note = (block: string, extra = "") => `---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette.

${extra}

# Excalidraw Data

## Text Elements
Label ^t1

%%
## Drawing
${block}
%%`;
// The plugin wraps the compressed text in short lines with blank lines between.
const compressed = "```compressed-json\n" + compressToBase64(JSON.stringify(scene)).replace(/(.{64})/g, "$1\n\n") + "\n```";
const plain = "```json\n" + JSON.stringify(scene) + "\n```";

describe("excalidraw → handwriting", () => {
  it("recognises drawings by file name or the plugin's frontmatter", () => {
    expect(isExcalidrawFile("畫畫/2024-12-30.excalidraw.md", "")).toBe(true);
    expect(isExcalidrawFile("notes/sketch.md", note(plain))).toBe(true);
    expect(isExcalidrawFile("notes/plain.md", "# Hello")).toBe(false);
  });

  it.each([["compressed-json", compressed], ["json", plain]])("decodes a %s drawing", (_kind, block) => {
    const result = decodeExcalidraw("畫畫/2024-12-30 11.51.22.excalidraw.md", note(block, "My caption."))!;
    expect(result.title).toBe("2024-12-30 11.51.22");
    // Deleted elements are gone; freedraw, arrow (+2 head strokes) and line drawn.
    expect(result.doc.strokes.map((s) => s.id)).toEqual(["f1", "f2", "a1", "a1-head0", "a1-head1", "l1"]);
    const f1 = result.doc.strokes[0];
    expect(f1.color).toBe("#e03131");
    expect(f1.toolId).toBe("pen");
    // Points keep their shape, moved to the page margin, with real pressure.
    expect(f1.points[0]).toEqual([24, 24, 0.2]);
    expect(f1.points[2]).toEqual([44, 34, 0.8]);
    // Simulated pressure → no pressure samples (the pen simulates it).
    expect(result.doc.strokes[1].points[0]).toHaveLength(2);
    expect(result.skipped).toEqual(expect.arrayContaining([
      { type: "image", count: 1, reason: expect.stringContaining("images") },
      { type: "frame", count: 1, reason: expect.stringContaining("frames") },
      { type: "text", count: 1, reason: expect.stringContaining("note body") },
    ]));
    // The note's own text and the drawing's text labels; no plugin banner or data.
    expect(result.body).toContain("My caption.");
    expect(result.body).toContain("Label");
    expect(result.body).not.toContain("EXCALIDRAW VIEW");
    expect(result.body).not.toContain("Excalidraw Data");
    // The plugin's frontmatter (its key, its #excalidraw tag) is dropped; the
    // old name becomes an alias so Obsidian's [[2024-12-30 11.51.22.excalidraw]]
    // links keep resolving. The original file is not kept.
    expect(result.body.startsWith('---\naliases: ["2024-12-30 11.51.22.excalidraw"]\n---\n')).toBe(true);
    expect(result).not.toHaveProperty("source");
    // It is an ordinary handwriting page for the one ink_data codec.
    expect(decodeInk(encodeInk(result.doc)).kind).toBe("page");
  });

  it("fits a wide drawing to the page width and scales stroke sizes with it", () => {
    const wide = { ...scene, elements: [{ id: "w", type: "freedraw", x: -1000, y: 0, strokeWidth: 2, points: [[0, 0], [1904, 0], [1904, 10]], pressures: [], simulatePressure: true }] };
    const result = decodeExcalidraw("w.excalidraw.md", note("```json\n" + JSON.stringify(wide) + "\n```"))!;
    const xs = result.doc.strokes[0].points.map((p) => p[0]);
    expect(Math.min(...xs)).toBe(24);
    expect(Math.max(...xs)).toBeCloseTo(976, 0);
    expect(result.doc.strokes[0].size).toBeCloseTo(2 * 4.25 * 0.5, 1);
  });

  it("returns null when there is no readable drawing, including one that parses but is malformed", () => {
    expect(decodeExcalidraw("x.excalidraw.md", "# just text")).toBeNull();
    expect(decodeExcalidraw("x.excalidraw.md", note("```compressed-json\nnot-base64!!\n```"))).toBeNull();
    expect(decodeExcalidraw("x.excalidraw.md", note('```json\n{"elements": 3}\n```'))).toBeNull();
    expect(decodeExcalidraw("x.excalidraw.md", note('```json\n{"elements": [{"type": "freedraw", "points": "nope"}]}\n```'))).toBeNull();
  });

  it("adds the old name to aliases the note already has, in its own YAML form", () => {
    const drawingPart = note(plain).split("---\n").slice(2).join("---\n");
    const front = (yaml: string) => decodeExcalidraw("d/x.excalidraw.md", `---\n${yaml}\n---\n${drawingPart}`)!.body.split("\n---\n")[0];
    expect(front("aliases: [mine]")).toBe('---\naliases: [mine, "x.excalidraw"]');
    expect(front("aliases: []")).toBe('---\naliases: ["x.excalidraw"]');
    expect(front("aliases: mine")).toBe('---\naliases: [mine, "x.excalidraw"]');
    expect(front("aliases:\n  - mine\ntags: [a]")).toBe('---\naliases:\n  - mine\n  - "x.excalidraw"\ntags: [a]');
    // Already there: left as written.
    expect(front('aliases: ["x.excalidraw"]')).toBe('---\naliases: ["x.excalidraw"]');
    // No frontmatter at all: one is made for the alias.
    expect(decodeExcalidraw("d/x.excalidraw.md", plain)!.body.startsWith('---\naliases: ["x.excalidraw"]\n---\n')).toBe(true);
  });

  it("rotates about the centre of the points' bounds, and blends translucent strokes toward the page", () => {
    // Points left of x (negative): a half-turn about their own centre keeps them in place, reversed.
    // An unrotated reference at x = 0 pins the page offset (24).
    const turned = { elements: [
      { id: "ref", type: "line", x: 0, y: 100, strokeWidth: 1, points: [[0, 0], [1, 0]] },
      { id: "r", type: "line", x: 100, y: 100, angle: Math.PI, strokeWidth: 1, opacity: 50, strokeColor: "#000000", points: [[-40, 0], [-20, 0]] },
    ] };
    const r = decodeExcalidraw("r.excalidraw.md", note("```json\n" + JSON.stringify(turned) + "\n```"))!;
    const [a, b] = r.doc.strokes[1].points;
    // Scene 60..80, reversed in place (about x 70) — not swung to 120..140 around x + width/2.
    expect([a[0], b[0]]).toEqual([24 + 80, 24 + 60]);
    expect(r.doc.strokes[1].color).toBe("#808080");
  });

  it("drops only the plugin's own frontmatter, in every tags form", () => {
    expect(withoutPluginFrontmatter("excalidraw-plugin: parsed\nexcalidraw-export-dark: false\ntitle: Mine")).toBe("title: Mine");
    expect(withoutPluginFrontmatter("tags: [excalidraw]")).toBe("");
    expect(withoutPluginFrontmatter("tags: [study, excalidraw, \"#Excalidraw\"]")).toBe("tags: [study]");
    expect(withoutPluginFrontmatter("tags: excalidraw")).toBe("");
    expect(withoutPluginFrontmatter("tags: math")).toBe("tags: math");
    expect(withoutPluginFrontmatter("tags:\n  - excalidraw\n  - math\naliases: [a]")).toBe("tags:\n  - math\naliases: [a]");
    expect(withoutPluginFrontmatter("tags:\n  - excalidraw\naliases: [a]")).toBe("aliases: [a]");
    // A multi-line plugin value goes with its key.
    expect(withoutPluginFrontmatter("excalidraw-css: |\n  a { }\n  b { }\ncssclasses: x")).toBe("cssclasses: x");
  });
});
