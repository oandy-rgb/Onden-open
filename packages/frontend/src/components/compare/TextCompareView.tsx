// The one two-version compare view (contract: ./comparePlaces.ts). The ONLY file that imports
// @codemirror/merge (compare.guard.test.ts), and itself loaded only when a compare opens
// (TextCompare.tsx → lazyWithReload), so the package stays out of the boot bundle.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { Change, MergeView, diff, getChunks, unifiedMergeView } from "@codemirror/merge";
import { ChevronDown, ChevronUp } from "lucide-react";
import { editorMarkdownLanguage, mdHighlight } from "../../lib/editorMarkdownLanguage";
import { BREAKPOINT_PX } from "../../lib/mediaQuery";
import { observeSize } from "../../lib/observeSize";
import { t, useT } from "../../lib/i18n";
import { Button } from "../ui";
import type { CompareChange, ComparePlace } from "./comparePlaces";
import "./TextCompare.css";

/** Longest the diff may run before the view settles for a summary. */
export const COMPARE_TIMEOUT_MS = 400;

export type CompareChanges = { changes: readonly Change[]; tooLong: boolean };

/** The places to draw: the caller's own cut when given, otherwise the package's diff under a time limit. */
export function compareChanges(before: string, after: string, places?: readonly CompareChange[], timeoutMs = COMPARE_TIMEOUT_MS): CompareChanges {
  if (places) return { changes: places.map((p) => new Change(p.before.from, p.before.to, p.after.from, p.after.to)), tooLong: false };
  const started = performance.now();
  const changes = diff(before, after, { timeout: timeoutMs });
  // The package falls back to a coarse answer when the limit hits and does not say so; the clock does.
  return { changes, tooLong: performance.now() - started >= timeoutMs };
}

export type CompareLayout = "auto" | "side-by-side" | "single";

export type TextCompareViewProps = {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  places?: readonly CompareChange[];
  placeActions?: (place: ComparePlace) => ReactNode;
  /** "auto": side by side when the box is wider than a phone (600px), one column below. */
  layout?: CompareLayout;
};

const COLLAPSE = { margin: 2, minSize: 4 } as const;

// Wording of the package's own "N unchanged lines" fold, in the app's language.
const phrases = () => EditorState.phrases.of({ "$ unchanged lines": t("$ unchanged lines") });

const compareTheme = EditorView.theme({
  "&": { fontSize: "0.9rem", fontFamily: "var(--ac-font-ui)", color: "var(--ac-ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "visible", lineHeight: "1.7", fontFamily: "inherit" },
  ".cm-content": { padding: "8px 12px", caretColor: "transparent" },
  ".cm-line": { padding: "0 4px" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--ac-muted)" },
  ".cm-changedLine, .cm-insertedLine": { backgroundColor: "color-mix(in srgb, var(--ac-success) 13%, transparent)" },
  ".cm-deletedLine, .cm-deletedChunk": { backgroundColor: "color-mix(in srgb, var(--ac-danger) 11%, transparent)" },
  ".cm-deletedChunk": { padding: "2px 0", fontFamily: "inherit" },
  ".cm-changedText, .cm-insertedText": { background: "color-mix(in srgb, var(--ac-success) 30%, transparent)", borderRadius: "2px" },
  ".cm-deletedText": { background: "color-mix(in srgb, var(--ac-danger) 28%, transparent)", borderRadius: "2px" },
  ".cm-changeGutter": { width: "3px", paddingLeft: "0" },
  ".cm-changedLineGutter, .cm-insertedLineGutter": { backgroundColor: "var(--ac-success)" },
  ".cm-deletedLineGutter": { backgroundColor: "var(--ac-danger)" },
  ".cm-collapsedLines": {
    color: "var(--ac-muted)", background: "var(--ac-accent-tint-3)", border: "1px dashed var(--ac-line)",
    borderRadius: "var(--ac-radius-md)", padding: "2px 8px", margin: "4px 8px", cursor: "pointer", textAlign: "center",
  },
});

function baseExtensions() {
  return [
    editorMarkdownLanguage(), syntaxHighlighting(mdHighlight), EditorView.lineWrapping,
    EditorState.readOnly.of(true), EditorView.editable.of(false), compareTheme, phrases(),
    EditorView.contentAttributes.of({ "aria-readonly": "true" }),
  ];
}

type Mounted = { destroy: () => void; chunks: () => ComparePlace[]; reveal: (place: ComparePlace) => void };

function mountSideBySide(parent: HTMLElement, before: string, after: string, changes: readonly Change[]): Mounted {
  const view = new MergeView({
    parent, orientation: "a-b", gutter: true, highlightChanges: true, collapseUnchanged: COLLAPSE,
    diffConfig: { override: () => changes },
    a: { doc: before, extensions: baseExtensions() },
    b: { doc: after, extensions: baseExtensions() },
  });
  return {
    destroy: () => view.destroy(),
    chunks: () => placesOf(view.b.state),
    reveal: (place) => {
      view.b.dispatch({ effects: EditorView.scrollIntoView(place.after.from, { y: "center" }) });
      view.a.dispatch({ effects: EditorView.scrollIntoView(place.before.from, { y: "center" }) });
    },
  };
}

function mountSingle(parent: HTMLElement, before: string, after: string, changes: readonly Change[]): Mounted {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: after,
      extensions: [...baseExtensions(), unifiedMergeView({
        original: before, mergeControls: false, gutter: true, highlightChanges: true, allowInlineDiffs: true,
        collapseUnchanged: COLLAPSE, diffConfig: { override: () => changes },
      })],
    }),
  });
  return {
    destroy: () => view.destroy(),
    chunks: () => placesOf(view.state),
    reveal: (place) => view.dispatch({ effects: EditorView.scrollIntoView(place.after.from, { y: "center" }) }),
  };
}

function placesOf(state: EditorState): ComparePlace[] {
  const found = getChunks(state);
  if (!found) return [];
  // `side` tells which document `state` is: the merge view's B side holds "after"; the unified view's own doc is "after" too.
  return found.chunks.map((chunk, index) => ({
    index,
    before: { from: chunk.fromA, to: chunk.toA, text: "" },
    after: { from: chunk.fromB, to: chunk.toB, text: state.sliceDoc(chunk.fromB, chunk.toB) },
  }));
}

export default function TextCompareView({ before, after, beforeLabel, afterLabel, places: given, placeActions, layout = "auto" }: TextCompareViewProps) {
  const T = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef<Mounted | null>(null);
  const [wide, setWide] = useState(true);
  const [found, setFound] = useState<ComparePlace[]>([]);
  const [current, setCurrent] = useState(0);

  const { changes, tooLong } = useMemo(() => compareChanges(before, after, given), [before, after, given]);
  const sideBySide = layout === "side-by-side" || (layout === "auto" && wide);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setWide(box.clientWidth === 0 || box.clientWidth > BREAKPOINT_PX.phone);
    measure();
    return observeSize(box, measure);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || tooLong) { setFound([]); return; }
    host.textContent = "";
    const mounted = (sideBySide ? mountSideBySide : mountSingle)(host, before, after, changes);
    mountedRef.current = mounted;
    // Each place's "before" text comes from the caller's texts (the single view has no A document to ask).
    setFound(mounted.chunks().map((p) => ({ ...p, before: { ...p.before, text: before.slice(p.before.from, p.before.to) } })));
    setCurrent(0);
    return () => { mounted.destroy(); mountedRef.current = null; };
  }, [before, after, changes, sideBySide, tooLong]);

  const go = (step: 1 | -1) => {
    if (found.length === 0) return;
    const next = (current + step + found.length) % found.length;
    setCurrent(next);
    mountedRef.current?.reveal(found[next]!);
  };

  if (tooLong) {
    return (
      <p className="text-compare-note" role="status">
        {T("These texts are too long to compare place by place, so only a summary is shown: {count} places differ.", { count: changes.length })}
      </p>
    );
  }
  const place = found[current];
  return (
    <div className={`text-compare${sideBySide ? " text-compare--split" : ""}`} ref={boxRef}>
      <div className="text-compare-bar">
        <span className="text-compare-legend">
          <span className="text-compare-key text-compare-key--before">{beforeLabel}</span>
          <span className="text-compare-key text-compare-key--after">{afterLabel}</span>
        </span>
        {found.length > 0 ? (
          <span className="text-compare-nav">
            <span className="text-compare-count" aria-live="polite">{T("Place {n} of {total}", { n: current + 1, total: found.length })}</span>
            <Button size="sm" variant="ghost" onClick={() => go(-1)} aria-label={T("Previous place")} disabled={found.length < 2}><ChevronUp size={14} /></Button>
            <Button size="sm" variant="ghost" onClick={() => go(1)} aria-label={T("Next place")} disabled={found.length < 2}><ChevronDown size={14} /></Button>
          </span>
        ) : <span className="text-compare-count">{T("No differences.")}</span>}
      </div>
      {place && placeActions && <div className="text-compare-actions">{placeActions(place)}</div>}
      {sideBySide && (
        <div className="text-compare-heads" aria-hidden="true"><span>{beforeLabel}</span><span>{afterLabel}</span></div>
      )}
      <div className="text-compare-host" ref={hostRef} />
    </div>
  );
}
