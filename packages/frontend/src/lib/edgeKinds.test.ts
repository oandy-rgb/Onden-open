import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { act, renderHook, waitFor } from "@testing-library/react";

const edgeManifest = vi.fn();
vi.mock("./data", () => ({ reads: { workspace: { edgeManifest: () => edgeManifest() } } }));

import {
  edgeKinds, edgeKindsFrom, FALLBACK_EDGE_COLOR, loadEdgeKinds, resetEdgeKindsForTest, useEdgeKinds,
  type EdgeKindSpec,
} from "./edgeKinds";
import { setLocalePref } from "./i18n";
import { ZH_TW } from "./i18n.zh-TW";

// The built-in registrations, read from the backend source (the manifest the
// server sends is exactly these plus whatever plugins add).
const backendSrc = readFileSync(resolve(__dirname, "../../../backend/src/services/edgeManifest.ts"), "utf8");
const builtins: EdgeKindSpec[] = [...backendSrc.matchAll(/registerEdgeType\(\{([\s\S]*?)\n\}\);/g)].map(([, body]) => {
  const field = (name: string) => body!.match(new RegExp(`\\n\\s*${name}: "([^"]*)"`))?.[1];
  return {
    kind: field("kind")!, describe: "", label: field("label")!, color: field("color")!,
    arrow: "source-to-target", planned: /\n\s*planned: true/.test(body!), pickable: /\n\s*pickable: true/.test(body!),
  };
});

const spec = (kind: string, extra: Partial<EdgeKindSpec> = {}): EdgeKindSpec =>
  ({ kind, describe: "", label: kind, color: "#123456", arrow: "source-to-target", ...extra });

beforeEach(() => {
  setLocalePref("en");
  edgeManifest.mockReset();
  resetEdgeKindsForTest();
});

describe("edgeKindsFrom", () => {
  const kinds = edgeKindsFrom(builtins);

  it("names a relation by its manifest label, translated", () => {
    expect(kinds.label("knowledge_link")).toBe("linked to");
    expect(kinds.label("highlight_source")).toBe("excerpt of");
    setLocalePref("zh-TW");
    expect(kinds.label("knowledge_link")).toBe("連結到");
    expect(kinds.label("highlight_source")).toBe("摘錄自");
    expect(kinds.label("parent")).toBe("位於");
  });

  it("an unknown type is named from its key and drawn in the fallback colour", () => {
    expect(kinds.label("cites_link")).toBe("cites");
    expect(kinds.label("depends_on")).toBe("depends on");
    expect(kinds.color("cites_link")).toBe(FALLBACK_EDGE_COLOR);
  });

  it("a plugin type gets its own label and colour", () => {
    const withPlugin = edgeKindsFrom([...builtins, spec("cites", { label: "cites", color: "#b0457a" })]);
    expect(withPlugin.label("cites")).toBe("cites");
    expect(withPlugin.color("cites")).toBe("#b0457a");
  });

  it("the arrow menu offers the pickable live types, in registration order", () => {
    expect(kinds.pickable.map((s) => s.kind)).toEqual(["knowledge_link", "suggested_link", "nav_link"]);
    expect(edgeKindsFrom([spec("x", { pickable: true, planned: true })]).pickable).toEqual([]);
  });
});

describe("the built-in manifest", () => {
  it("parses: every registration has a kind, label and #rrggbb colour", () => {
    expect(builtins.length).toBeGreaterThanOrEqual(7);
    for (const b of builtins) {
      expect(b.kind, JSON.stringify(b)).toBeTruthy();
      expect(b.label, b.kind).toBeTruthy();
      expect(b.color, b.kind).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("every label has a zh-TW translation", () => {
    for (const b of builtins) expect(ZH_TW[b.label], b.label).toBeTruthy();
  });

  // Edge colours are only ever lines, arrowheads and swatches beside a text
  // label (the label itself uses the text colour), so WCAG 1.4.11 non-text
  // contrast applies: 3:1. One colour serves both themes, so it must clear
  // 3:1 on the light AND dark page/surface backgrounds (tokens.css).
  it("every colour reads at ≥ 3:1 on both themes' backgrounds", () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a) + 0.05, lum(b) + 0.05];
      return Math.max(x, y) / Math.min(x, y);
    };
    const tokens = readFileSync(join(__dirname, "../styles/tokens.css"), "utf8");
    const [light, dark] = tokens.split(/\[data-theme="dark"\]\s*\{/);
    const surfaces = (css: string) => ["bg", "surface", "elevated"].map((n) => css.match(new RegExp(`--ac-${n}:\\s*(#[0-9a-f]{6})`, "i"))![1]!);
    const backgrounds = [...surfaces(light!), ...surfaces(dark!)];
    expect(backgrounds).toEqual(["#f8f4ec", "#f0ece4", "#fffdf9", "#1c1a17", "#201d17", "#27241e"]);
    for (const color of [...builtins.map((b) => b.color), FALLBACK_EDGE_COLOR]) {
      for (const bg of backgrounds) expect(ratio(color, bg), `${color} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("loading", () => {
  it("useEdgeKinds re-renders when the manifest arrives, and caches it for an offline start", async () => {
    edgeManifest.mockResolvedValue(builtins);
    const { result } = renderHook(() => useEdgeKinds());
    expect(result.current.label("highlight_source")).toBe("highlight source");
    await waitFor(() => expect(result.current.label("highlight_source")).toBe("excerpt of"));
    expect(result.current.color("knowledge_link")).toBe(builtins.find((b) => b.kind === "knowledge_link")!.color);
    expect(JSON.parse(localStorage.getItem("onden.edgeManifest")!)).toHaveLength(builtins.length);
    expect(edgeManifest).toHaveBeenCalledTimes(1);
  });

  it("fetches once; an empty or failed answer keeps what is there and retries later", async () => {
    edgeManifest.mockResolvedValueOnce([spec("a")]);
    await act(() => loadEdgeKinds());
    await loadEdgeKinds();
    expect(edgeManifest).toHaveBeenCalledTimes(1);

    resetEdgeKindsForTest([spec("kept")]);
    edgeManifest.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("offline"));
    await loadEdgeKinds();
    await loadEdgeKinds();
    expect(edgeManifest).toHaveBeenCalledTimes(3);
    expect(edgeKinds().specs.map((s) => s.kind)).toEqual(["kept"]);
  });
});

describe("one vocabulary", () => {
  it("no graph component keeps its own edge name table or edge colours", () => {
    const files = [
      ...readdirSync(join(__dirname, "../components")).map((f) => join(__dirname, "../components", f)),
      ...readdirSync(join(__dirname, "../hooks")).map((f) => join(__dirname, "../hooks", f)),
    ].filter((f) => /\.(tsx?|css)$/.test(f) && !/\.test\./.test(f));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\b(EDGE_HUMAN|REL_HUMAN|EDGE_KIND_HUMAN|EDGE_TYPE_LABELS)\b/);
      expect(src, f).not.toMatch(/(knowledge_link|suggested_link|nav_link|highlight_source):\s*["{]/);
      expect(src, f).not.toMatch(/\.ctx-edge-swatch--/);
      expect(src, f).not.toMatch(/\["knowledge_link", "suggested_link"/);
    }
  });
});
