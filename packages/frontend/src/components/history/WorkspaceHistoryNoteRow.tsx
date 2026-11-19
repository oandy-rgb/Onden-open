import { useState } from "react";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { Menu, MenuItem, Pressable, usePopover } from "../ui";
import { useHistorySpace } from "./historySpace";
import { useAccountSession } from "../../lib/accountSession";
import { useT } from "../../lib/i18n";
import { changeSummaryText, inkChangeText } from "../../lib/history";
import type { DayNote } from "@onden/contract";
import InkChangeDisclosure from "./InkChangeDisclosure";
import { timeLabel } from "../../lib/timeLabels";
import { displayTitle } from "../../lib/noteLabel";

type Props = {
  note: DayNote;
  onOpen: () => void;
  /** Two columns: the row whose history is open on the right. */
  selected?: boolean;
  /** Identifies the row for the list's arrow keys. */
  rowId?: string;
  /** 「回到這之前」: look at the workspace just before this note's first save of the day. */
  onGoBackBefore?: () => void;
  /** Dimmed: it is newer than the point being looked at, so a rewind to there would undo it. */
  afterCut?: boolean;
  /** The server can be reached: a drawing's picture is read when it is opened. */
  online?: boolean;
};

/** One edited note: title and time, what changed in words, then the first changed paragraph. */
export default function WorkspaceHistoryNoteRow({ note, onOpen, selected = false, rowId, onGoBackBefore, afterCut = false, online = true }: Props) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const pop = usePopover<HTMLButtonElement>({ open: menuOpen, onClose: () => setMenuOpen(false), placement: "bottom-end" });
  const spaceName = useHistorySpace().labelFor(note.space_id);
  const selfName = useAccountSession()?.user.name ?? null;
  // Before the account is known, a lone person is taken to be you (as the screen always did).
  const isYou = (a: DayNote["actors"][number]) => a.kind === "human" && (selfName === null || a.name === selfName);
  const names = note.actors.every(isYou) ? "" : note.actors.map((a) => (a.kind === "session" ? t("A temporary session") : isYou(a) ? t("You") : a.name)).join(" · ");
  const changed = note.change && note.change.added + note.change.changed + note.change.removed > 0;
  // A note made that day with nothing in it yet is new, not "no change".
  const what = note.change && (changed || !note.created)
    ? changeSummaryText(t, note.change)
    : note.created ? t("New") : t("Edited {n} times", { n: note.edits });
  // A drawing's change is told beside the text's: "New · Handwriting: drew 12, erased 3". A note's handwriting
  // page and its whiteboard's pen layer are told apart.
  const drawings = ([["handwriting", note.ink], ["board", note.board_ink]] as const).flatMap(([kind, change]) => (change ? [{ kind, change }] : []));
  const meta = drawings.length > 0
    ? [changed ? what : note.created ? t("New") : null, ...drawings.map((d) => inkChangeText(t, d.kind, d.change))].filter(Boolean).join(" · ")
    : what;
  const sample = note.change?.sample ?? null;
  return (
    <li className={(onGoBackBefore ? "wh-note-item" : "") + (afterCut ? " wh-after-cut" : "")}>
      <Pressable type="button" className={"wh-note-link wh-touch" + (selected ? " selected" : "")} aria-current={selected || undefined} data-row={rowId} onClick={onOpen}>
        <span className="wh-note-text">
          <span className="wh-note-head">
            <span className="wh-note-titleline">
              <span className="wh-note-title">{displayTitle(note.title)}</span>
              {spaceName && <span className="wh-note-space">{spaceName}</span>}
            </span>
            <span className="wh-note-time">{timeLabel(note.last_at)}</span>
          </span>
          <span className="wh-note-meta">{names ? `${meta} · ${names}` : meta}</span>
          {sample && (
            <span className={"wh-note-sample" + (note.change?.sample_kind === "removed" ? " removed" : "")}>{sample}</span>
          )}
        </span>
        {afterCut && <span className="wh-cut-badge">{t("Will be undone")}</span>}
        <ChevronRight size={16} aria-hidden="true" />
      </Pressable>
      {onGoBackBefore && (
        <>
          <Pressable ref={pop.anchor} type="button" className="wh-note-more wh-touch" aria-label={t("More actions")}
            aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            <MoreHorizontal size={16} aria-hidden="true" />
          </Pressable>
          {menuOpen && (
            <Menu popover={pop} label={t("More actions")}>
              <MenuItem onSelect={onGoBackBefore}>{t("Go back to before this")}</MenuItem>
            </Menu>
          )}
        </>
      )}
      {drawings.map((d) => <InkChangeDisclosure key={d.kind} noteId={note.id} kind={d.kind} change={d.change} online={online} />)}
    </li>
  );
}
