import { useCallback, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { addToast, getAppState, getNode, useOnline } from "../lib/appStore";
import { blockAnchorsEnabled } from "../lib/blockAnchorStore";
import { blockChildWriter, drafts, type BlockChildOutcome, type UnwritableReferences } from "../lib/data";
import { canMoveToChild, childEmbedAt, paragraphToMove } from "../lib/editorParagraphActions";
import { useT } from "../lib/i18n";
import { displayTitle } from "../lib/noteLabel";

/** What the paragraph menu and the selection bubble show for one paragraph:
 *  「變成子筆記」 and 「展開回內文」. `disabled` is the reason an entry can't run
 *  now (it is still shown, with the reason). */
/** The selected text of the editor: offsets into the note, and what is there. */
export type SelectionSpan = { from: number; to: number; text: string };

export type BlockChildEntry = { run: () => void; disabled?: string };
export type BlockChildEntries = { move?: BlockChildEntry; expand?: BlockChildEntry };

/** The operations that turn a paragraph (with its section, for a heading) or a
 *  selected text into a child note of this note, and back (docs/architecture/block-nodes.md).
 *  Each is one server write that follows the references too; the editor only
 *  settles what the server needs first — which paragraph (by its anchor, else its
 *  text) and the note's pending edit — and shows the answer. */
export function useBlockChildNote({ viewRef, nodeKey, readOnly, confirmDialog }: {
  viewRef: RefObject<EditorView | null>;
  nodeKey: string | undefined;
  readOnly: boolean;
  /** The app's question dialog (components/ConfirmDialog; a hook may not import components). */
  confirmDialog: (message: string, options?: { confirmLabel?: string; cancelLabel?: string | null }) => Promise<boolean>;
}) {
  const t = useT();
  const online = useOnline();

  /** `standing`: a whole paragraph kept its identity (獨立出去 / 收回原文), so the words say so. A selected text
   *  has no identity to keep and still reads as a move into a child note. */
  const finish = useCallback(async (kind: "move" | "expand", noteId: string, outcome: BlockChildOutcome, knownTitle?: string, standing = false) => {
    if (outcome.kind !== "done") return;
    const title = knownTitle ?? getNode(outcome.childId)?.title ?? "";
    const links = outcome.rewritten > 0 ? ` ${t("Links in {n} other note(s) now follow.", { n: outcome.rewritten })}` : "";
    const message = kind === "move"
      ? t(standing ? "“{title}” is now its own note." : "Moved into the child note “{title}”.", { title })
      : t(standing ? "Took “{title}” back into the text." : "Put “{title}” back into the text.", { title });
    addToast(message + links, "success", {
      label: t("Undo"),
      // The editor shows the note as it was, unless it was edited since (restoreOverviewDraft).
      onClick: () => {
        let restored = false;
        void drafts.restore(noteId, async () => {
          const node = await blockChildWriter.undo(noteId, outcome.eventId);
          restored = node !== null;
          return node ?? undefined;
        }).then((ran) => { if (ran && restored) addToast(t("Undone"), "success"); });
      },
    });
    if (outcome.left > 0) addToast(t("{n} notes you can't edit still link to the old place.", { n: outcome.left }), "info");
  }, [t]);

  const describe = useCallback((refs: UnwritableReferences) => {
    const titles = refs.notes.slice(0, 5).map((n) => `“${displayTitle(n.title)}”`).join(", ");
    const more = refs.notes.length > 5 ? t(" and {n} more", { n: refs.notes.length - 5 }) : "";
    const unseen = refs.hidden > 0 ? ` ${t("({n} more you can't see)", { n: refs.hidden })}` : "";
    return `${titles}${more}${unseen}`;
  }, [t]);

  /** Run a move, asking once whether to go on when some links are in notes the person can't edit. */
  const settleMove = useCallback(async (
    note: { id: string },
    rewrite: { adopt: (markdown: string) => void },
    attempt: (options?: { leaveUnwritable?: boolean }) => Promise<BlockChildOutcome>,
    standing = false,
  ) => {
    let outcome = await attempt();
    if (outcome.kind === "unwritable") {
      const go = await confirmDialog(
        t("Links to this part are in notes you can't edit: {notes}. Move it anyway? Those links will keep pointing at the old place.", { notes: describe(outcome.references) }),
        { confirmLabel: t("Move anyway") });
      if (!go) return;
      outcome = await attempt({ leaveUnwritable: true });
    }
    if (outcome.kind === "done") rewrite.adopt(outcome.noteMarkdown);
    await finish("move", note.id, outcome, undefined, standing);
  }, [t, describe, finish, confirmDialog]);

  const move = useCallback(async (pos: number) => {
    const view = viewRef.current;
    const note = getNode(nodeKey);
    if (!view || !note) return;
    const part = paragraphToMove(view, pos);
    if (!part) { addToast(t("This part can't be moved into a child note."), "error"); return; }
    // The server reads the note as saved: the pending edit goes first.
    const rewrite = await drafts.beginRewrite(note);
    if (!rewrite) return;
    if (rewrite.body.slice(part.from, part.to) !== part.text) { addToast(t("The paragraph changed. Try again."), "error"); return; }
    // A paragraph with an anchor keeps its identity (獨立出去); one without has none to keep, so its text is moved.
    const standing = part.ref !== null && blockAnchorsEnabled();
    await settleMove(
      note, rewrite,
      (options) => part.ref !== null
        ? blockChildWriter.moveToChild(note.id, part.ref, { ...options, keepIdentity: standing })
        : blockChildWriter.moveSelectionToChild(note.id, { from: part.from, to: part.to, text: part.text }, options),
      standing);
  }, [viewRef, nodeKey, t, settleMove]);

  /** The selected text `[from, to)` of the editor, as a child note. */
  const moveSelection = useCallback(async (span: SelectionSpan) => {
    const note = getNode(nodeKey);
    if (!viewRef.current || !note || !span.text.trim()) return;
    const rewrite = await drafts.beginRewrite(note);
    if (!rewrite) return;
    // The server reads the note as saved; what was selected must still be there.
    if (rewrite.body.slice(span.from, span.to) !== span.text) { addToast(t("The text changed. Select it again."), "error"); return; }
    await settleMove(note, rewrite, (options) => blockChildWriter.moveSelectionToChild(note.id, span, options));
  }, [viewRef, nodeKey, t, settleMove]);

  const expand = useCallback(async (childId: string) => {
    const note = getNode(nodeKey);
    if (!note) return;
    const rewrite = await drafts.beginRewrite(note);
    if (!rewrite) return;
    // Read before: the child is in the trash, and gone from the store, afterwards.
    const title = getNode(childId)?.title ?? "";
    const outcome = await blockChildWriter.expand(note.id, childId);
    if (outcome.kind === "unwritable") {
      await confirmDialog(
        t("Notes you can't edit link to this child note: {notes}. It stays a child note, because those links would break.", { notes: describe(outcome.references) }),
        { confirmLabel: t("OK"), cancelLabel: null });
      return;
    }
    if (outcome.kind === "done") rewrite.adopt(outcome.noteMarkdown);
    await finish("expand", note.id, outcome, title, blockAnchorsEnabled());
  }, [nodeKey, t, describe, finish, confirmDialog]);

  /** The entries for the paragraph at `pos`. */
  const entries = useCallback((pos: number): BlockChildEntries => {
    const view = viewRef.current;
    if (!view || !nodeKey || readOnly) return {};
    const disabled = online ? undefined : t("Needs a connection: this creates a note.");
    const child = childEmbedAt(view, pos, nodeKey, getAppState().data.nodes);
    if (child) return { expand: { run: () => void expand(child.id), disabled: online ? undefined : t("Needs a connection: this removes a note.") } };
    return canMoveToChild(view, pos) ? { move: { run: () => void move(pos), disabled } } : {};
  }, [viewRef, nodeKey, readOnly, online, t, move, expand]);

  /** 「變成子筆記」 for the selected text `span`: undefined where the note can't be changed. */
  const selectionEntry = useCallback((span: SelectionSpan): BlockChildEntry | undefined =>
    !nodeKey || readOnly || !span.text.trim() ? undefined
      : { run: () => void moveSelection(span), disabled: online ? undefined : t("Needs a connection: this creates a note.") },
  [nodeKey, readOnly, online, t, moveSelection]);

  /** 「展開回內文」 for the child note `childId` an embed shows (the embed sheet's button). */
  const expandEntry = useCallback((childId: string): BlockChildEntry | undefined =>
    !nodeKey || readOnly || getNode(childId)?.parent_id !== nodeKey ? undefined : { run: () => void expand(childId), disabled: online ? undefined : t("Needs a connection: this removes a note.") },
  [nodeKey, readOnly, online, t, expand]);

  return { entries, selectionEntry, expandEntry };
}
