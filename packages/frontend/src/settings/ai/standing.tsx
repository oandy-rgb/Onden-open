import { useCallback, useState } from "react";

import { addToast } from "../../lib/appStore";
import { writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { refreshSpaces, spaceApi, spaceLabel, type Space } from "../../lib/spaces";
import { confirmDialog } from "../../components/ConfirmDialog";
import { Button } from "../../components/ui";
import PermissionControl, { useStandingLabel, type Standing } from "./PermissionControl";
import "./strings";

// The ONE write path for where a person or an AI stands in a space (不在 / 可看 / 可編輯), and for the
// space's 「讓 AI 讀」 switch. 「空間與成員」 (people in a space) and 「設定 › AI」 (spaces of an AI) both draw
// it, so neither rewrites the write, the 復原 toast or the confirmation:
//   const standing = useStandingWriter({ previousOf, reload });   standing.change(person, space, "view")
//   const allowAiRead = useAllowAiRead(reload);                    allowAiRead(space)
//   <StandingCell person space value busy onChange onAllowAiRead />   one space's line for one AI

/** Applies a standing and says so with a 復原; the undo is itself not offered another. `previousOf` is what
 *  the caller's picture says the standing was before (for the toast and the undo). */
export function useStandingWriter({ previousOf, reload }: {
  previousOf: (personId: string, space: Space) => Standing;
  reload: () => void | Promise<void>;
}) {
  const t = useT();
  const standingLabel = useStandingLabel();
  const [busyCell, setBusyCell] = useState<string | null>(null);
  const change = useCallback(async (person: { id: string; name: string }, space: Space, next: Standing, undoable = true): Promise<void> => {
    const previous = previousOf(person.id, space);
    setBusyCell(`${person.id}:${space.id}`);
    let saved = false;
    try { await spaceApi.setMember(space.id, person.id, next === "none" ? null : next); await refreshSpaces(); saved = true; }
    catch (error) { writeErrors.report(error, addToast); }
    finally { setBusyCell(null); }
    await reload();
    if (!saved || !undoable) return;
    const where = spaceLabel(space);
    const message = next === "none" ? t("{name} was moved out of {space}", { name: person.name, space: where })
      : previous === "none" ? t("{name} was added to {space}", { name: person.name, space: where })
      : t("{name} is now “{standing}” in {space}", { name: person.name, standing: standingLabel(next), space: where });
    addToast(message, "success", { label: t("Undo"), onClick: () => void change(person, space, previous, false) });
  // `previousOf` and `reload` are read at call time through the caller's refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, standingLabel]);
  return { change, busyCell };
}

/** Turn a space's 「AI can read」 switch on, after the owner agrees: it lets every AI standing in that space read its notes. */
export function useAllowAiRead(reload: () => void | Promise<void>) {
  const t = useT();
  return useCallback(async (space: Space): Promise<boolean> => {
    if (!(await confirmDialog(t("Let AI read the notes in “{space}”? Every AI that stands in this space will be able to read them.", { space: spaceLabel(space) }), { confirmLabel: t("Allow AI to read") }))) return false;
    let done = false;
    try { await spaceApi.update(space.id, { capabilities: { external_ai: true } }); await refreshSpaces(); done = true; }
    catch (error) { writeErrors.report(error, addToast); }
    await reload();
    return done;
  }, [t, reload]);
}

/** One space's line for one AI: its name and the standing menu. A space that does not let AI read has the menu
 *  turned off, says so, and offers the button that turns the switch on (after a confirmation). */
export function StandingCell({ person, space, value, busy, readOnly, onChange, onAllowAiRead }: {
  person: { id: string; name: string };
  space: Space;
  value: Standing;
  busy: boolean;
  readOnly?: boolean;
  onChange: (next: Standing) => void;
  onAllowAiRead: () => void;
}) {
  const t = useT();
  const closed = space.capabilities.external_ai !== true;
  const where = spaceLabel(space);
  const standingLabel = useStandingLabel();
  // A membership that is still stored while the space is closed is shown as it is stored, and said to have no effect now.
  const dormant = closed && value !== "none";
  return (
    <li className="standing-cell" data-ai-read={closed ? "off" : "on"}>
      <span className="standing-cell-name">{where}</span>
      <PermissionControl label={t("{name} in {space}", { name: person.name, space: where })} name={person.name} leave="skip"
        value={value} readOnly={readOnly} busy={busy || closed} onChange={onChange} />
      {closed && (
        <span className="standing-cell-closed">
          <span className="member-hint">
            {dormant
              ? t("This space doesn't let AI read, so “{standing}” has no effect now. Letting AI read here brings it back.", { standing: standingLabel(value) })
              : t("This space doesn't let AI read.")}
          </span>
          {!readOnly && <Button variant="secondary" size="sm" className="ai-touch" disabled={busy} onClick={onAllowAiRead}>{t("Let AI read here")}</Button>}
        </span>
      )}
    </li>
  );
}
