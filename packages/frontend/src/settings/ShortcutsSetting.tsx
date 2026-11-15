import { useEffect, useState, useSyncExternalStore } from "react";
import { useT } from "../lib/i18n";
import { isEscapeKey } from "../lib/keys";
import {
  chordOf, chordProblem, defaultChord, effectiveShortcuts, formatChord, resetShortcuts,
  setShortcutChord, subscribeShortcuts, type Shortcut,
} from "../lib/shortcuts";
import { FieldError, Button } from "../components/ui";
import type { SettingContext } from "../lib/settingsTypes";
import { onWindow } from "../lib/globalEvents";

// Settings › Keyboard shortcuts: every shortcut with the keys in effect on this
// device; Change records the next key combination (Escape cancels). A
// combination another shortcut already has is refused and names it; one the
// editor, the whiteboard or undo already answers, or a key with no modifier,
// is refused too (lib/shortcuts chordProblem).

let version = 0;
const subscribe = (onChange: () => void) => subscribeShortcuts(() => { version += 1; onChange(); });
const snapshot = () => version;

function grouped(list: Shortcut[]): { group: string; rows: Shortcut[] }[] {
  const order: string[] = [];
  const rows = new Map<string, Shortcut[]>();
  for (const s of list) {
    if (!rows.has(s.group)) { rows.set(s.group, []); order.push(s.group); }
    rows.get(s.group)!.push(s);
  }
  return order.map((group) => ({ group, rows: rows.get(group)! }));
}

export default function ShortcutsSetting(_: { ctx: SettingContext }) {
  const t = useT();
  useSyncExternalStore(subscribe, snapshot);
  const [recording, setRecording] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);
  const list = effectiveShortcuts();
  const changed = list.filter((s) => s.chord !== defaultChord(s.id));

  // While recording, the next key combination is the new shortcut. Capture
  // phase, ahead of the app's own shortcut handlers, so pressing (say) ⌘K here
  // doesn't also open the palette.
  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (isEscapeKey(e)) { setRecording(null); return; }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return; // still holding modifiers
      const chord = chordOf(e);
      const found = chordProblem(recording!, chord);
      if (found?.reason === "taken") {
        setProblem({ id: recording!, message: t("{keys} is already “{name}”.", { keys: formatChord(chord), name: t(found.by.label) }) });
        return;
      }
      if (found) {
        const keys = formatChord(chord);
        const message = found.reason !== "reserved"
          ? t("{keys} can't be a shortcut. Use a key with ⌘/Ctrl, Shift or Alt.", { keys })
          : found.owner === "editor" ? t("{keys} is the text editor's own key (bold, italic and the like).", { keys })
          : found.owner === "board" ? t("{keys} picks a whiteboard tool.", { keys })
          : found.owner === "undo" ? t("{keys} is undo or redo.", { keys })
          : t("{keys} is kept for typing, moving, copying and closing.", { keys });
        setProblem({ id: recording!, message });
        return;
      }
      setShortcutChord(recording!, chord);
      setProblem(null);
      setRecording(null);
    }
    return onWindow("keydown", onKey, true);
  }, [recording, t]);

  return (
    <div className="settings-shortcuts">
      <p className="settings-hint">{t("Shortcuts without ⌘/Ctrl work only when you are not typing in a text field.")}</p>
      {grouped(list).map(({ group, rows }) => (
        <section key={group} className="settings-shortcuts-group" aria-label={t(group)}>
          <h5 className="settings-row-title">{t(group)}</h5>
          {rows.map((s) => {
            const isRecording = recording === s.id;
            const isChanged = s.chord !== defaultChord(s.id);
            return (
              <div key={s.id} className="settings-row settings-shortcut-row" data-shortcut={s.id}>
                <span className="settings-label settings-shortcut-label">{t(s.label)}</span>
                <kbd className={`settings-shortcut-kbd${isRecording ? " is-recording" : ""}`} aria-live="polite">
                  {isRecording ? t("Press keys…") : formatChord(s.chord)}
                </kbd>
                <Button variant="secondary" size="sm"
                  aria-label={isRecording ? t("Cancel") : t("Change “{name}”", { name: t(s.label) })}
                  onClick={() => { setProblem(null); setRecording(isRecording ? null : s.id); }}>
                  {isRecording ? t("Cancel") : t("Change")}
                </Button>
                {isChanged && !isRecording && (
                  <Button variant="ghost" size="sm"
                    aria-label={t("Reset “{name}”", { name: t(s.label) })}
                    onClick={() => { setShortcutChord(s.id, null); setProblem(null); }}>
                    {t("Reset")}
                  </Button>
                )}
                {problem?.id === s.id && <FieldError>{problem.message}</FieldError>}
              </div>
            );
          })}
        </section>
      ))}
      {changed.length > 0 && (
        <Button variant="secondary" size="sm" className="settings-btn--inline-action"
          onClick={() => { resetShortcuts(); setProblem(null); setRecording(null); }}>
          {t("Reset all shortcuts")}
        </Button>
      )}
    </div>
  );
}
