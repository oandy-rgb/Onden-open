import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { EditorView } from "@codemirror/view";
import { BlockHistorySheet } from "./history";
import { addToast } from "../lib/appStore";
import { blockPreviewRange, setBlockPreview } from "../lib/blockHistoryPreview";
import { clearParagraphFrame, frameParagraph } from "../lib/editorParagraphFrame";
import { splitParagraphs } from "@onden/markdown";
import { paragraphIndexAt } from "../lib/history";
import { useT } from "../lib/i18n";

type Open = { markdown: string; offset: number; from: number; to: number };

/** 「這段的歷史」 in the editor: `open(pos)` shows the sheet for the paragraph at
 *  `pos`, which frames it and previews older wordings in place (display only).
 *  「用這個版本」 replaces just that paragraph with one ordinary editor
 *  transaction, so the editor's own save carries it (queue, conflicts and all);
 *  the notice's 「復原」 puts the previous wording back if nothing touched it since. */
export function useBlockHistory({ viewRef, nodeKey, readOnly, onOpenNoteHistory }: {
  viewRef: RefObject<EditorView | null>;
  nodeKey: string | undefined;
  readOnly: boolean;
  onOpenNoteHistory?: (versionId: string | null) => void;
}) {
  const t = useT();
  const [session, setSession] = useState<Open | null>(null);
  const range = useRef<{ from: number; to: number } | null>(null);

  const close = useCallback(() => {
    const view = viewRef.current;
    if (view) { view.dispatch({ effects: setBlockPreview.of(null) }); clearParagraphFrame(view); }
    range.current = null;
    setSession(null);
  }, [viewRef]);
  // A sheet belongs to the note it opened on.
  useEffect(() => close, [nodeKey, close]);

  const open = useCallback((pos: number) => {
    const view = viewRef.current;
    if (!view || !nodeKey) return;
    const markdown = view.state.doc.toString();
    const paragraphs = splitParagraphs(markdown);
    const at = paragraphs[paragraphIndexAt(paragraphs, pos)];
    if (!at || at.kind === "frontmatter" || pos > at.bodyEnd + 1) { addToast(t("Put the cursor in a paragraph first"), "error"); return; }
    range.current = { from: at.start, to: at.bodyEnd };
    frameParagraph(view, range.current);
    view.dispatch({
      effects: [setBlockPreview.of({ from: at.start, to: at.bodyEnd, text: null }), EditorView.scrollIntoView(at.start, { y: "start", yMargin: 24 })],
    });
    setSession({ markdown, offset: at.start, from: at.start, to: at.bodyEnd });
  }, [viewRef, nodeKey, t]);

  const preview = (text: string | null) => {
    const view = viewRef.current;
    const where = view && blockPreviewRange(view.state) || range.current;
    if (view && where) view.dispatch({ effects: setBlockPreview.of({ ...where, text }) });
  };

  const use = (text: string, when: string) => {
    const view = viewRef.current;
    const where = view && (blockPreviewRange(view.state) ?? range.current);
    if (!view || !where) return;
    const before = view.state.doc.sliceString(where.from, where.to);
    view.dispatch({ changes: { from: where.from, to: where.to, insert: text }, userEvent: "input.history-block" });
    close();
    addToast(t("This part was changed back to how it was {when}", { when }), "success", {
      label: t("Take it back"),
      onClick: () => {
        const v = viewRef.current;
        // Only while the new wording is still there untouched.
        if (!v || v.state.doc.sliceString(where.from, where.from + text.length) !== text) {
          addToast(t("The paragraph was edited since, so it was left as it is"), "error");
          return;
        }
        v.dispatch({ changes: { from: where.from, to: where.from + text.length, insert: before }, userEvent: "input.history-block" });
      },
    });
  };

  const sheet = session && nodeKey && (
    <BlockHistorySheet
      nodeId={nodeKey} markdown={session.markdown} offset={session.offset} canUse={!readOnly}
      onPreview={preview} onUse={use} onOpenNoteHistory={onOpenNoteHistory && ((id) => { close(); onOpenNoteHistory(id); })}
      onClose={close}
    />
  );
  return { open: nodeKey ? open : undefined, sheet };
}
