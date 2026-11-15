import { describe, it, expect } from "vitest";

// services/edgeManifest exposes a tiny registry — the relevant behaviour is
// the public shape (built-ins registered, planned-vs-live flag, duplicate
// rejection). No DB / no app harness.

const { listEdgeTypeManifest, isRegisteredEdgeType, registerEdgeType } =
  await import("../services/edgeManifest.js");

describe("edge type manifest", () => {
  it("returns at least the four live built-ins plus planned slots", () => {
    const manifest = listEdgeTypeManifest();
    const kinds = manifest.map((m) => m.kind);
    for (const must of ["knowledge_link", "suggested_link", "nav_link", "highlight_source"]) {
      expect(kinds).toContain(must);
    }
    // Planned slots are also there so the substrate doesn't fight name collisions later
    expect(kinds).toContain("parent");
    expect(kinds).toContain("canvas_member");
  });

  it("flags planned-vs-live correctly", () => {
    const manifest = listEdgeTypeManifest();
    const highlight = manifest.find((m) => m.kind === "highlight_source")!;
    const parent    = manifest.find((m) => m.kind === "parent")!;
    expect(highlight.planned ?? false).toBe(false);
    expect(parent.planned).toBe(true);
  });

  it("isRegisteredEdgeType matches what listEdgeTypeManifest reports", () => {
    expect(isRegisteredEdgeType("highlight_source")).toBe(true);
    expect(isRegisteredEdgeType("not_a_real_type_xyz")).toBe(false);
  });

  it("registerEdgeType rejects duplicates", () => {
    expect(() => registerEdgeType({
      kind: "highlight_source",
      describe: "duplicate attempt",
      label: "duplicate",
      color: "#000000",
      arrow: "source-to-target",
    })).toThrow(/already registered/);
  });

  it("every type has a reader label and a #rrggbb colour; the pickable ones are the live links", () => {
    const manifest = listEdgeTypeManifest();
    for (const m of manifest) {
      expect(m.label.trim(), m.kind).not.toBe("");
      expect(m.label, m.kind).not.toContain("_");
      expect(m.color, m.kind).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(manifest.filter((m) => m.pickable).map((m) => m.kind))
      .toEqual(["knowledge_link", "suggested_link", "nav_link"]);
    expect(manifest.filter((m) => m.pickable && m.planned)).toEqual([]);
  });

  it("registerEdgeType rejects a missing label or a colour that is not #rrggbb", () => {
    expect(() => registerEdgeType({
      kind: "test_no_label", describe: "x", label: " ", color: "#123456", arrow: "none",
    })).toThrow(/needs a label/);
    expect(() => registerEdgeType({
      kind: "test_bad_color", describe: "x", label: "x", color: "var(--x)", arrow: "none",
    })).toThrow(/#rrggbb/);
    expect(listEdgeTypeManifest().map((m) => m.kind)).not.toContain("test_bad_color");
  });
});
