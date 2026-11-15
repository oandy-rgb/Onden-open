import "./ShortcutsCheatsheet.css";
import { useEffect, useState } from "react";
import { Modal, SheetHeader } from "./ui";
import { effectiveShortcuts, formatChord, matchShortcut, type Shortcut } from "../lib/shortcuts";
import { useCanvasImported, useDailyNotesEnabled } from "../hooks/useModuleFilter";
import { useT } from "../lib/i18n";
import { onWindow } from "../lib/globalEvents";

// WU-2 — self-contained keyboard cheatsheet.
//
// Mount once (BuilderApp does this) and it needs no further wiring: it owns its
// own open state via a window keydown listener. The "?" chord (defined in
// SHORTCUTS as id="shortcuts-help") toggles it open; Escape / backdrop close it.
// Every displayed kbd reads from the same SHORTCUTS list via formatChord so the
// dispatcher, palette and cheatsheet can never disagree (see lib/shortcuts.ts).

// SHORTCUTS is authored in display order; preserve that order both for the
// groups and the rows within a group.
function groupedShortcuts(boards: boolean, daily: boolean): { group: string; rows: Shortcut[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, Shortcut[]>();
  // The keys in effect on this device (Settings › Keyboard shortcuts).
  for (const s of effectiveShortcuts()) {
    if (s.board && !boards) continue;
    // ⌘⇧D opens today's note: listed only while daily notes (日記) are on.
    if (s.id === "daily-note" && !daily) continue;
    let rows = byGroup.get(s.group);
    if (!rows) {
      rows = [];
      byGroup.set(s.group, rows);
      order.push(s.group);
    }
    rows.push(s);
  }
  return order.map((group) => ({ group, rows: byGroup.get(group)! }));
}

export default function ShortcutsCheatsheet() {
  const t = useT();
  const canvasImported = useCanvasImported();
  const dailyOn = useDailyNotesEnabled();
  const [open, setOpen] = useState(false);

  // Global open/close listener. The "?" chord only fires outside editable
  // fields (matchShortcut enforces that), so typing "?" in the editor or a
  // search box never pops the sheet. Escape is the Modal's.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const hit = matchShortcut(e);
      if (hit?.id === "shortcuts-help") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    // The palette's "Keyboard shortcuts" command opens the sheet the same way
    // the "?" key does, for people without a keyboard to hand or who do not know the key.
    const onOpenRequest = () => setOpen(true);
    const stopKey = onWindow("keydown", onKeyDown);
    const stopRequest = onWindow("onden-open-shortcuts-help", onOpenRequest);
    return () => { stopKey(); stopRequest(); };
  }, []);

  if (!open) return null;

  const groups = groupedShortcuts(canvasImported, dailyOn);

  return (
    <Modal label={t("Keyboard shortcuts")} className="shortcuts-backdrop" onClose={() => setOpen(false)}>
      <div className="shortcuts-modal">
        <SheetHeader className="shortcuts-header" title={t("Keyboard shortcuts")} onClose={() => setOpen(false)} />
        <div className="shortcuts-body">
          {groups.map(({ group, rows }) => (
            <section key={group} className="shortcuts-group">
              <h3 className="shortcuts-group-title">{t(group)}</h3>
              <ul className="shortcuts-list">
                {rows.map((s) => (
                  <li key={s.id} className="shortcuts-row">
                    <span className="shortcuts-label">{t(s.label)}</span>
                    <kbd className="shortcuts-kbd">{formatChord(s.chord)}</kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}
