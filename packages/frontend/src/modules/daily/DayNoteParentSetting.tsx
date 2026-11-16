// The daily-notes module's one setting: the note new day notes go under.
// Unset = the personal space's top level (as before the setting). It is kept
// for the signed-in account on the server (lib/data/dayNoteParentStore, via
// lib/data/dayNotes dayNoteParentSetting), so it follows the person to every
// device and the widget updates when another device changes it. A chosen note
// that is not in the loaded notes yet is not "gone": the choice is kept and
// only a finished load can say the note is missing. It only decides
// where openToday CREATES a note; existing day notes stay where they are and
// are still found. Moving the existing ones under the parent is a separate,
// explicit click (「把現有的 N 篇日記移到這裡」): each is an ordinary reparent
// through the note writer (evented, undoable), never done automatically.

import { keyBetween } from "@onden/markdown/contract";
import { useMemo, useState } from "react";
import { addToast, useAppSelector, useAllNodes } from "../../lib/appStore";
import { dayNotesOutside, noteStructure, noteWriter, usableDayNoteParent } from "../../lib/data";
import { dayNoteParentSetting, useDayNoteParent } from "../../lib/data";
import { dayNoteDate } from "@onden/markdown";
import { useT } from "../../lib/i18n";
import { rankByTitle } from "../../lib/noteSearch";
import { personalSpaceId } from "../../lib/spaces";
import { Button, SearchField } from "../../components/ui";
import type { SettingContext } from "../../lib/settingsTypes";
import "./DayNoteParentSetting.css";

export default function DayNoteParentSetting(_props: { ctx: SettingContext }) {
  const t = useT();
  const nodes = useAllNodes();
  const bootstrapped = useAppSelector((s) => s.bootstrapped);
  const { value: parentId } = useDayNoteParent();
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const [moving, setMoving] = useState(false);
  const spaceId = personalSpaceId();
  const parent = parentId ? nodes.find((n) => n.id === parentId) : undefined;
  const usable = usableDayNoteParent(nodes, parentId, spaceId);

  // Notes a day note may go under: your own (personal space), live, visible
  // content notes — not a day note itself.
  const candidates = useMemo(() => nodes.filter((n) =>
    usableDayNoteParent(nodes, n.id, spaceId) === n.id && dayNoteDate(n) === null), [nodes, spaceId]);
  const matches = query.trim() ? rankByTitle(query.trim(), candidates, (n) => n.title || "", 8) : [];

  // Your day notes that live elsewhere (only offered once a usable parent is set).
  const outside = useMemo(() => usable ? dayNotesOutside(nodes, usable, spaceId) : [], [nodes, usable, spaceId]);

  async function moveHere() {
    if (!usable || moving) return;
    setMoving(true);
    // Oldest first, after the parent's current children.
    const last = noteStructure.children(usable).at(-1);
    let after: string | null = last?.order_key ?? null;
    let moved = 0;
    for (const day of outside) {
      try {
        const next = keyBetween(after, null);
        await noteWriter.patch(day.id, { parent_id: usable, order_key: next });
        after = next;
        moved += 1;
      } catch {
        // The note writer reported it; the others still move.
      }
    }
    setMoving(false);
    if (moved) addToast(t(moved === 1 ? "Moved {n} day note." : "Moved {n} day notes.", { n: moved }), "success");
  }

  function choose(id: string | null) {
    dayNoteParentSetting.set(id);
    setPicking(false);
    setQuery("");
  }

  return (
    <div className="day-note-parent">
      <p className="settings-hint">{t("Day notes you already have stay where they are and are still found.")}</p>
      <p className="settings-hint">{parentId
        ? (usable
          ? t("New day notes go under “{title}”.", { title: parent?.title || t("Untitled") })
          : !spaceId
            ? t("Your spaces have not loaded yet, so new day notes go at the top level for now.")
            : !parent && !bootstrapped
              ? t("New day notes go under the note you chose.")
              : t("The chosen note is gone or not in your personal space, so new day notes go at the top level."))
        : t("New day notes go at the top level of your personal space.")}</p>
      <div className="settings-row settings-row--actions">
        <Button type="button" variant="secondary" onClick={() => setPicking((open) => !open)} aria-expanded={picking}>
          {parentId ? t("Change note…") : t("Choose a note…")}
        </Button>
        {parentId && <Button type="button" variant="ghost" onClick={() => choose(null)}>{t("Use the top level")}</Button>}
      </div>
      {outside.length > 0 && (
        <div className="settings-row settings-row--actions">
          <Button type="button" variant="secondary" disabled={moving} onClick={() => void moveHere()}>
            {moving ? t("Moving…") : t(outside.length === 1 ? "Move {n} existing day note here" : "Move {n} existing day notes here", { n: outside.length })}
          </Button>
        </div>
      )}
      {picking && (
        <div className="day-note-parent-picker">
          <SearchField autoFocus label={t("Search notes…")} value={query} onValueChange={setQuery} />
          {query.trim() && matches.length === 0 && <p className="settings-hint">{t("No notes match")}</p>}
          <ul className="day-note-parent-results">
            {matches.map((n) => (
              <li key={n.id}>
                <Button type="button" variant="ghost" onClick={() => choose(n.id)}>{n.title || t("Untitled")}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
