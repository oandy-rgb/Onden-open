// Guards for the handwriting / PDF / media consolidation (review 2026-10-27,
// docs/archive/research/review-2026-10-27/deep-modules-ink-media.md). Each test pins
// one thing that now lives in exactly one place.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SRC, findImports, findUses, sourceFiles } from "./sources";

describe("lib/ink and lib/pdf", () => {
  // The engine is a host-agnostic module that PDF uses, not a peer that knows
  // PDF. The stored PDF shapes and the ink_data envelope adapter live in lib/pdf.
  it("lib/ink does not import lib/pdf", () => {
    expect(findImports(sourceFiles("lib/ink", { tests: true }), /(^|\/)pdf(\/|$)/)).toEqual([]);
  });
});

describe("PDF drawings: page units are the one form hosts work with", () => {
  // A PDF's strokes and shapes are InkDocuments in page units (lib/pdf/pageUnits);
  // the older form (records in a capture frame + pages[n]) is generated from them
  // at the one place that writes a page. A host or a session building records or
  // converting frames itself is a second conversion that drifts.
  const LEGACY_WRITERS = ["lib/pdf/pageUnits.ts", "lib/pdf/pdfAdapter.ts", "lib/pdf/capture.ts"];
  it("the older form is written only by lib/pdf/pageUnits", () => {
    expect(findUses(sourceFiles("."), /\b(addDrawingToPage|addShapeToPage|drawingRecord|shapeRecord)\(/, LEGACY_WRITERS)).toEqual([]);
  });

  it("frames are converted only there (recordFrame is not used by hosts)", () => {
    expect(findUses(sourceFiles("."), /\brecordFrame\b/, ["lib/pdf/pageUnits.ts", "lib/pdf/index.ts"])).toEqual([]);
  });

  it("an engine on a PDF page loads and saves the page: no per-surface viewport or px scale in the session", () => {
    expect(findUses(sourceFiles("lib/pdf"), /\b(loadPageDrawings|applyPageEdits|PageEditState)\b/)).toEqual([]);
  });
});

describe("device checks", () => {
  // Which device is touching (pen, finger, mouse) is decided by the ink
  // engine's input policy, which hands hosts a tool and gesture callbacks.
  // A component asking pointerType itself is a second, drifting rule.
  const POINTER_TYPE_IN_COMPONENTS: readonly string[] = [
    // A slider that ignores non-primary mouse buttons; no pen/touch decision.
    "components/history/HistorySlider.tsx",
  ];
  it("components do not read pointerType", () => {
    expect(findUses(sourceFiles("components"), /\bpointerType\b/, POINTER_TYPE_IN_COMPONENTS)).toEqual([]);
  });

  it("navigator.maxTouchPoints is read in one function, lib/ink/touch.ts", () => {
    expect(findUses(sourceFiles("."), /maxTouchPoints/, ["lib/ink/touch.ts"])).toEqual([]);
  });
});

describe("pen shortcut wiring", () => {
  // usePenShortcutTool returns one stable function; a host hands it to the
  // engine as is. A host-side ref that forwards to it is the old 3× copy.
  it("hosts do not wrap the pen shortcut in their own ref", () => {
    expect(findUses(sourceFiles("components"), /penShortcutRef/)).toEqual([]);
  });
});

describe("media players", () => {
  // The wrapper that lets a closing player fade out lives in <MediaPlayer>;
  // the note text and the whiteboard card both render it. A second copy of the
  // wrapper is a second player that drifts (and needs a cast to take a ref).
  it("md-media-wrap is written only by the MediaPlayer component", () => {
    expect(findUses(sourceFiles("."), /md-media-wrap/, ["components/MediaPlayer.tsx"])).toEqual([]);
  });

  it("no `ref as never` casts in components", () => {
    expect(findUses(sourceFiles("components"), /ref=\{[^}]*\bas never\b/)).toEqual([]);
  });
});

describe("insert-file helpers", () => {
  // lib/mediaInsert once exported a predicate only its own test called.
  // Whatever it exports must be used by real code, not just by a test.
  it("every export of lib/mediaInsert is imported by non-test code", () => {
    const text = readFileSync(join(SRC, "lib/mediaInsert.ts"), "utf8");
    const names = [...text.matchAll(/export (?:const|function|class) (\w+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    const unused = names.filter((name) => findUses(sourceFiles("."), new RegExp(`\\b${name}\\b`), ["lib/mediaInsert.ts"]).length === 0);
    expect(unused).toEqual([]);
  });
});

describe("scrolling and flicking", () => {
  // One hand-made flick: its feel (decay, stop speed) is in lib/ink/glide.ts,
  // called by the page book's camera. The PDF view is a page book too (PdfNodeView),
  // so it has no camera of its own to grow a copy of the numbers.
  it("the flick constants exist only in lib/ink/glide.ts", () => {
    expect(findUses(sourceFiles("."), /\b(FLING_DECAY|FLING_STOP_SPEED|PINCH_SETTLE\w*)\b/, ["lib/ink/glide.ts"])).toEqual([]);
  });

  it("startGlide is called only by the cameras that glide: the page book and the whiteboard", () => {
    expect(findUses(sourceFiles("."), /\bstartGlide\(/, ["lib/ink/glide.ts", "pagebook/PageBook.tsx", "hooks/useBoardCamera.ts"])).toEqual([]);
  });

  // Fingers and the pen reach a scroll container through its camera — the page book's, for
  // handwriting and PDF alike — not a second hand-wired install in a view.
  it("installTouchSplit is called only by the page book", () => {
    expect(findUses(sourceFiles("."), /\binstallTouchSplit\(/, ["lib/ink/touchSplit.ts", "pagebook/PageBook.tsx"])).toEqual([]);
  });
});

describe("pages with their own engines (src/pagebook)", () => {
  // A page's engine — canvases, transform, near-screen, the pen's size at a zoom — is PageInkSurface,
  // for the notebook and the PDF alike; a host making its own is a copy that drifts.
  it("an InkEngine is built for a page only in pagebook/PageInkSurface", () => {
    expect(findUses(sourceFiles("components"), /new InkEngine\(/, ["components/CanvasInkLayer.tsx"])).toEqual([]);
    expect(findUses(sourceFiles("pagebook"), /new InkEngine\(/, ["pagebook/PageInkSurface.tsx"])).toEqual([]);
  });

  // Which engines have unsaved edits, and where undo goes, is InkPageSession; a host keeping its own
  // map of engines would lose edits when a page scrolls away.
  it("engines are registered with a session only by the page surface", () => {
    expect(findUses(sourceFiles("."), /session\.attach\(/, ["pagebook/PageInkSurface.tsx"])).toEqual([]);
  });
});
