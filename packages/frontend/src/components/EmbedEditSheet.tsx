import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Pencil } from "lucide-react";
import { embedEditable } from "@onden/markdown";
import { anchorSpansOf } from "../lib/blockAnchorStore";
import { useCardDraft, type SaveCardBody } from "../hooks/useCardDraft";
import { drafts } from "../lib/data";
import { embedSource, type EmbedSource } from "../lib/embedSources";
import type { EditableEmbed } from "../lib/embedDom";
import { useT } from "../lib/i18n";
import PanelHeader from "./PanelHeader";
import ShellDialog from "./ShellDialog";
import "./EmbedEditSheet.css";
import { Button, Pressable, TextArea } from "./ui";

/** What `target` of note `noteId` shows in `markdown`, as one editable text: a block is found by the note's anchors, which are read against that very text. */
const editableOf = (markdown: string, target: { blockId?: string | null; heading?: string | null }, noteId: string) =>
  embedEditable(markdown, target, anchorSpansOf(noteId, markdown));

type Props = {
  embed: EditableEmbed;
  /** The note the embed is written in: when it is also the source, the edit
   *  goes through that note's open draft instead of a second writer. */
  hostNodeId: string | null;
  /** May this person change the source note? Read-only otherwise. */
  canEdit: boolean;
  onOpenSource: (nodeId: string, title: string) => void;
  /** Show the `![[…]]` text of the embed that opened this sheet. Left out where
   *  the embed is not written in any note (the review screen): there is no
   *  syntax to show, so the button is not offered. */
  onRevealSyntax?: () => void;
  /** Put this child note's text back into the host note (「展開回內文」); only
   *  given for an embed of one of the host's own child notes. */
  onExpand?: { run: () => void; disabled?: string };
  onClose: () => void;
};

/** Edit what a block / section / note embed shows, in the note it comes from.
 *  The text is the embed's own range (@onden/markdown embedEditable); each save
 *  puts it back into the whole source note as one of that note's saves —
 *  merged onto its newer text from the version the sheet opened on, like a
 *  whiteboard card (drafts.saveBody). A phone shows it as a bottom sheet, a
 *  desktop as a side panel (EmbedEditSheet.css). */
export default function EmbedEditSheet({ embed, hostNodeId, canEdit, onOpenSource, onRevealSyntax, onExpand, onClose }: Props) {
  const t = useT();
  const [source, setSource] = useState<EmbedSource | null>(null);
  useEffect(() => {
    let live = true;
    void embedSource(embed.node).then((read) => { if (live) setSource(read); });
    return () => { live = false; };
    // The sheet edits the note it opened on; a sync that follows is not a reopen.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The text the sheet opened on, with the editor's unsaved draft of that note
  // (the host note embedding its own block) taking precedence.
  const opened = useMemo(() => {
    if (!source?.ok) return null;
    const whole = drafts.read(embed.node.id)?.markdown ?? source.markdown;
    const target = embed.kind === "block" ? { blockId: embed.blockId, heading: null } : { blockId: null, heading: embed.heading };
    const editable = editableOf(whole, target, embed.node.id);
    return editable && { whole, target, text: editable.text };
  }, [source, embed]);

  const title = source?.ok ? embed.node.title || embed.label : "";
  const header = (
    <PanelHeader icon={<Pencil size={16} aria-hidden="true" />} title={title ? t("Edit: {title}", { title }) : t("Edit embed")} onClose={() => void close()}>
      {opened && (
        <Pressable type="button" className="embed-edit-open" title={t("Open the source note")} aria-label={t("Open the source note")}
          onClick={() => void leave(() => onOpenSource(embed.node.id, embed.node.title))}>
          <ArrowUpRight size={16} aria-hidden="true" />
        </Pressable>
      )}
    </PanelHeader>
  );

  // Close once the input is saved; a refused save keeps the sheet and the input.
  const body = useRef<{ flush: () => Promise<boolean> } | null>(null);
  async function close() {
    if (!body.current || await body.current.flush()) onClose();
  }
  async function leave(then: () => void) {
    if (body.current && !(await body.current.flush())) return;
    onClose();
    // After the dialog has given focus back to where it came from.
    setTimeout(then, 0);
  }

  return (
    <ShellDialog sheet label={title ? t("Edit: {title}", { title }) : t("Edit embed")} className="embed-edit-sheet" onClose={() => void close()}>
      {header}
      {source === null && <p className="embed-edit-note" role="status">{t("Loading…")}</p>}
      {source && !source.ok && (
        <p className="embed-edit-note" role="status">
          {source.reason === "forbidden" ? t("Content you cannot access") : source.reason === "notFound" ? t("Not found") : t("Cannot load this right now")}
        </p>
      )}
      {source?.ok && !opened && <p className="embed-edit-note" role="status">{t("This block was not found")}</p>}
      {opened && (
        <SheetEditor
          ref={body} nodeId={embed.node.id} hostNodeId={hostNodeId} opened={opened} canEdit={canEdit}
          onRevealSyntax={onRevealSyntax && (() => void leave(onRevealSyntax))}
          onExpand={onExpand && { ...onExpand, run: () => void leave(onExpand.run) }}
        />
      )}
    </ShellDialog>
  );
}

type Opened = { whole: string; target: { blockId: string | null; heading: string | null }; text: string };

function SheetEditor({ ref, nodeId, hostNodeId, opened, canEdit, onRevealSyntax, onExpand }: {
  ref: React.Ref<{ flush: () => Promise<boolean> }>;
  nodeId: string; hostNodeId: string | null; opened: Opened; canEdit: boolean; onRevealSyntax?: () => void;
  onExpand?: Props["onExpand"];
}) {
  const t = useT();
  // The whole source each sent text was built on, keyed by the part's text:
  // the hook names the part it sent from (`base`), a refused send hands that
  // name back, and the next send then builds on the same whole.
  const wholes = useRef(new Map([[opened.text, opened.whole]]));
  const save: SaveCardBody = async (_id, text, { keepalive, base }) => {
    const before = wholes.current.get(base) ?? opened.whole;
    const whole = editableOf(before, opened.target, nodeId)?.apply(text) ?? before;
    if (whole === before) return;
    if (nodeId === hostNodeId) {
      // The open note's own draft: its autosave sends it (drafts.editText).
      const done = await drafts.editText(nodeId, (current) => editableOf(current, opened.target, nodeId)?.apply(text) ?? current);
      if (done !== "applied") throw new Error("embed edit not applied");
    } else {
      await drafts.saveBody(nodeId, whole, before, { keepalive });
    }
    wholes.current.set(text, whole);
  };
  const draft = useCardDraft(nodeId, opened.text, save);
  const flushRef = useRef(draft.flush);
  flushRef.current = draft.flush;
  useImperativeHandle(ref, () => ({ flush: () => flushRef.current() }), []);

  return (
    <>
      {!canEdit && <p className="embed-edit-note" role="status">{t("You can read this note but not change it, so this opens read-only.")}</p>}
      <TextArea
        className="embed-edit-text" aria-label={t("Source text")} value={draft.content} readOnly={!canEdit} spellCheck={false}
        onChange={(e) => { if (canEdit) draft.edit(e.target.value); }} onBlur={() => void draft.flush()}
      />
      {draft.status !== "idle" && (
        <div className="embed-edit-status" role="status">
          <span>{t(draft.status === "unsaved" ? "Unsaved card changes" : draft.status === "saving" ? "Saving card…" : "Card changes not saved")}</span>
          {draft.status === "rejected" && <Button type="button" onClick={() => void draft.retry()}>{t("Retry saving")}</Button>}
        </div>
      )}
      {onRevealSyntax && <Pressable type="button" className="embed-edit-syntax" onClick={onRevealSyntax}>{t("Edit embed syntax")}</Pressable>}
      {onExpand && (
        <Pressable type="button" className="embed-edit-syntax" disabled={!!onExpand.disabled} title={onExpand.disabled} onClick={onExpand.run}>
          {t("Expand back into the text")}
        </Pressable>
      )}
    </>
  );
}
