// Arrow-left/right and Delete by grapheme cluster. CodeMirror's own commands
// glue a stray zero-width joiner to the next letter and step through decomposed
// Hangul (a macOS file name) jamo by jamo; Intl.Segmenter follows Unicode's
// cluster rules. Backspace stays CodeMirror's (it removes one mark at a time).

import type { Command, KeyBinding } from "@codemirror/view";
import { cursorCharLeft, cursorCharRight, deleteCharForward } from "@codemirror/commands";

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Offset (in `text`) of the cluster boundary after `from` (`dir` 1) or before it (`dir` -1). */
function clusterBoundary(text: string, from: number, dir: 1 | -1): number {
  let prev = 0;
  for (const { index } of SEGMENTER.segment(text)) {
    if (dir === 1 && index > from) return index;
    if (dir === -1 && index >= from) return prev;
    prev = index;
  }
  return dir === 1 ? text.length : prev;
}

/** Cluster edge next to an empty selection on the same line; null when the stock command should act (selection, line edge). */
function edgeBeside(view: Parameters<Command>[0], dir: 1 | -1): number | null {
  const sel = view.state.selection.main;
  if (!sel.empty) return null;
  const line = view.state.doc.lineAt(sel.head);
  if (dir === 1 ? sel.head >= line.to : sel.head <= line.from) return null;
  return line.from + clusterBoundary(line.text, sel.head - line.from, dir);
}

const cursorByCluster = (dir: 1 | -1, fallback: Command): Command => (view) => {
  const to = edgeBeside(view, dir);
  if (to === null) return fallback(view);
  view.dispatch({ selection: { anchor: to }, scrollIntoView: true, userEvent: "select" });
  return true;
};

export const cursorClusterRight = cursorByCluster(1, cursorCharRight);
export const cursorClusterLeft = cursorByCluster(-1, cursorCharLeft);

export const deleteClusterForward: Command = (view) => {
  const to = edgeBeside(view, 1);
  if (to === null || view.state.readOnly) return deleteCharForward(view);
  const from = view.state.selection.main.head;
  view.dispatch({ changes: { from, to }, selection: { anchor: from }, scrollIntoView: true, userEvent: "delete.forward" });
  return true;
};

/** Goes before `defaultKeymap`. */
export const clusterKeymap: readonly KeyBinding[] = [
  { key: "ArrowRight", run: cursorClusterRight },
  { key: "ArrowLeft", run: cursorClusterLeft },
  { key: "Delete", run: deleteClusterForward },
];
