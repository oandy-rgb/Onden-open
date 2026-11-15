// 「還原到 10/23 下午06:00」: the last look before a rewind. Three lists, everything checked, and one
// plain sentence on what a rewind covers. Nothing here is final: the result is a card in the feed with
// 「撤銷這次還原」. Stays open on a failure, with the choices as they were.
import { useMemo, useState } from "react";
import { Button, Sheet } from "../ui";
import { useT } from "../../lib/i18n";
import { historyWriter, writeErrors } from "../../lib/data";
import { REWIND_MAX_NOTES } from "@onden/markdown";
import type { AtNote } from "@onden/contract";
import { useHistorySpace } from "./historySpace";
import { cutWhen, type Cut } from "./rewindCut";
import { displayTitle } from "../../lib/noteLabel";
import { Checkbox } from "../ui";
import type { RewindResult } from "@onden/contract";

type Props = {
  cut: Cut;
  /** Every note that differs from then (the preview's list). */
  notes: AtNote[];
  online: boolean;
  onClose: () => void;
  /** `undefined`: applied, but its report was lost (historyWriter has said so). */
  onDone: (result: RewindResult | undefined) => void;
};

const GROUPS = [
  { status: "changed", field: "restore_ids" },
  { status: "deleted_since", field: "undelete_ids" },
  { status: "created_since", field: "delete_ids" },
] as const;

export default function RewindConfirm({ cut, notes, online, onClose, onDone }: Props) {
  const t = useT();
  const { spaceId, labelFor } = useHistorySpace();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(notes.map((n) => n.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const when = cutWhen(cut);

  const byStatus = useMemo(() => ({
    changed: notes.filter((n) => n.status === "changed"),
    deleted_since: notes.filter((n) => n.status === "deleted_since"),
    created_since: notes.filter((n) => n.status === "created_since"),
  }), [notes]);
  const titles: Record<(typeof GROUPS)[number]["status"], (n: number) => string> = {
    changed: (n) => t("Restore the text of {n} notes", { n }),
    deleted_since: (n) => t("Bring back {n} deleted notes", { n }),
    created_since: (n) => t("{n} notes added since (moved to Recently deleted, you can bring them back any time)", { n }),
  };
  const count = picked.size;
  const tooMany = count > REWIND_MAX_NOTES;

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const setGroup = (ids: string[], on: boolean) => setPicked((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });

  const submit = async () => {
    if (busy || count === 0 || tooMany || !online) return;
    setBusy(true);
    setError(null);
    try {
      const ids = (status: (typeof GROUPS)[number]["status"]) => byStatus[status].filter((n) => picked.has(n.id)).map((n) => n.id);
      const result = await historyWriter.rewindWorkspace({
        t: cut.at, ...(spaceId ? { space: spaceId } : {}),
        restore_ids: ids("changed"), undelete_ids: ids("deleted_since"), delete_ids: ids("created_since"),
      });
      onDone(result);
    } catch (e) {
      setError(writeErrors.message(e));
      setBusy(false);
    }
  };

  return (
    <Sheet label={t("Restore to {when}", { when })} className="wh-sheet-layer" busy={busy} onClose={onClose} cardClassName="wh-sheet" desktop="bottom">
      <h3>{t("Restore to {when}", { when })}</h3>
      <p className="wh-sheet-explain">
        {t("Only the notes' text and which notes exist are restored. Where notes sit and their tags stay as they are now; whiteboards, handwriting, files, tags themselves and settings are not changed.")}
      </p>
      {GROUPS.map(({ status }) => {
        const list = byStatus[status];
        if (list.length === 0) return null;
        const ids = list.map((n) => n.id);
        const all = ids.every((id) => picked.has(id));
        return (
          <section key={status} className="wh-rewind-group" data-group={status}>
            <label className="wh-check wh-touch wh-rewind-group-head">
              <Checkbox checked={all} onChange={() => setGroup(ids, !all)} />
              <strong>{titles[status](ids.filter((id) => picked.has(id)).length)}</strong>
            </label>
            <ul className="wh-sheet-list">
              {list.map((n) => (
                <li key={n.id}>
                  <label className="wh-check wh-touch">
                    <Checkbox checked={picked.has(n.id)} onChange={() => toggle(n.id)} />
                    <span className="wh-rewind-title">{displayTitle(status === "created_since" ? n.title_now : n.title_then)}</span>
                    {labelFor(n.space_id) && <span className="wh-note-space">{labelFor(n.space_id)}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {tooMany && <p className="wh-error" role="alert">{t("A rewind can change at most 2000 notes at once. Uncheck some and try again.")}</p>}
      {!online && <p className="wh-sheet-explain">{t("You're offline. Restoring needs a connection.")}</p>}
      {error && <p className="wh-error" role="alert">{error}</p>}
      <div className="wh-sheet-actions">
        <Button variant="secondary" className="wh-touch" disabled={busy} onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="primary" className="wh-touch" disabled={busy || !online || count === 0 || tooMany} onClick={() => void submit()}>
          {t("Restore {n} notes", { n: count })}
        </Button>
      </div>
    </Sheet>
  );
}
