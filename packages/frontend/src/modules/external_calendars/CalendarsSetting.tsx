// Settings › Features › External calendars: the calendars the person follows.
// Each is an iCal link pasted once; the server keeps the link encrypted and answers
// only its host, so a saved link cannot be read back. Online only: the server
// has to accept a calendar (and read it once) before it shows here.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Button, FieldError, Pressable, Switch, TextField } from "../../components/ui";
import { confirmDialog } from "../../components/ConfirmDialog";
import { EXTERNAL_CALENDAR_NAME_MAX } from "@onden/markdown";
import { CARD_COLORS } from "../../lib/cardColors";
import { calendarWriter, reads, writeErrors } from "../../lib/data";
import type { ExternalCalendar } from "../../lib/externalCalendars";
import { useT } from "../../lib/i18n";
import { dateLabel } from "../../lib/timeLabels";
import { randomUUID } from "../../lib/uuid";
import type { SettingContext } from "../../lib/settingsTypes";
import "./strings";
import "./calendars.css";

// The server refuses an eleventh (backend store.ts MAX_CALENDARS_PER_PERSON); the page says so before it offers the form.
const MAX_CALENDARS = 10;
const COLORS = CARD_COLORS.flatMap((c) => (c.value ? [{ label: c.label, value: c.value }] : []));
const ERROR_TEXT = {
  unreachable: "The calendar couldn't be opened. Check the link and try again later.",
  not_calendar: "That link isn't a calendar.",
  too_large: "That calendar is too big to read.",
  blocked: "That link can't be used.",
} as const;

function Swatches({ value, onPick }: { value: string; onPick: (color: string) => void }) {
  const t = useT();
  return (
    <div className="cal-swatches" role="radiogroup" aria-label={t("Color")}>
      {COLORS.map((c) => (
        <Pressable key={c.value} type="button" role="radio" aria-checked={value === c.value} aria-label={t(c.label)}
          className="cal-swatch" data-on={value === c.value} style={{ "--ext-color": c.value } as CSSProperties} onClick={() => onPick(c.value)} />
      ))}
    </div>
  );
}

export default function CalendarsSetting({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const [list, setList] = useState<{ available: boolean; calendars: ExternalCalendar[] } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [color, setColor] = useState(COLORS[4]!.value);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; color: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // One id per attempt: a press repeated after a lost answer finds the calendar the first one made.
  const [attemptId, setAttemptId] = useState(randomUUID);

  const load = useCallback(async () => {
    try {
      setList(await reads.workspace.externalCalendars<{ available: boolean; calendars: ExternalCalendar[] }>());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    if (adding || !name.trim() || !url.trim()) return;
    setAdding(true);
    setMessage(null);
    try {
      await calendarWriter.follow({ id: attemptId, name: name.trim(), color, url: url.trim() });
      setName(""); setUrl(""); setAttemptId(randomUUID());
      await load();
    } catch (e) {
      // The link stays in the box so it can be fixed.
      setMessage(writeErrors.message(e));
    } finally {
      setAdding(false);
    }
  }

  async function change(id: string, patch: { name?: string; color?: string; enabled?: boolean }) {
    setBusyId(id);
    setMessage(null);
    try {
      await calendarWriter.change(id, patch);
      setEditing(null);
      await load();
    } catch (e) {
      setMessage(writeErrors.message(e));
    } finally {
      setBusyId(null);
    }
  }

  async function refresh(id: string) {
    setBusyId(id);
    setMessage(null);
    try {
      await calendarWriter.refresh(id);
      await load();
    } catch (e) {
      setMessage(writeErrors.message(e));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(calendar: ExternalCalendar) {
    if (!(await confirmDialog(t("Stop following “{name}”? Its events disappear from your timeline.", { name: calendar.name }), { confirmLabel: t("Stop following") }))) return;
    setBusyId(calendar.id);
    setMessage(null);
    try {
      await calendarWriter.stopFollowing(calendar.id);
      await load();
    } catch (e) {
      setMessage(writeErrors.message(e));
    } finally {
      setBusyId(null);
    }
  }

  const online = ctx.online;
  const unavailable = list && !list.available;
  const full = (list?.calendars.length ?? 0) >= MAX_CALENDARS;
  return (
    <section className="cal-setting" aria-label={t("External calendars")}>
      <h3 className="cal-title">{t("External calendars")}</h3>
      <p className="cal-help">{t("Paste a calendar's iCal link to see its events on your timeline. They are only shown, never changed, and only you can see them.")}</p>
      {!online && <p className="cal-note">{t("Connect to the server to add or change calendars.")}</p>}
      {loadFailed && <p className="cal-note">{t("The calendars couldn't be loaded.")}</p>}
      {unavailable && <p className="cal-note">{t("This server isn't set up to keep calendar links safely, so calendars can't be added.")}</p>}
      {full && <p className="cal-note">{t("You can follow up to 10 calendars. Remove one first.")}</p>}

      <ul className="cal-list">
        {list?.calendars.map((calendar) => {
          const busy = busyId === calendar.id;
          const edit = editing?.id === calendar.id ? editing : null;
          return (
            <li key={calendar.id} className="cal-row">
              <div className="cal-row-main">
                <span className="cal-dot" style={{ "--ext-color": calendar.color } as CSSProperties} aria-hidden="true" />
                <div className="cal-row-text">
                  <span className="cal-row-name">{calendar.name}</span>
                  <span className="cal-row-host">{calendar.host}</span>
                  <span className="cal-row-state">
                    {calendar.last_error ? t(ERROR_TEXT[calendar.last_error])
                      : calendar.last_fetched_at ? t("Updated {when}", { when: dateLabel(calendar.last_fetched_at, "shortDateTime") })
                      : t("Not read yet")}
                  </span>
                </div>
                <Switch on={calendar.enabled} label={t("Show {name}", { name: calendar.name })} disabled={!online || busy}
                  onChange={(on) => void change(calendar.id, { enabled: on })} />
              </div>
              {calendar.last_error && calendar.last_fetched_at && (
                <span className="cal-row-state">{t("Showing what was read on {when}.", { when: dateLabel(calendar.last_fetched_at, "shortDateTime") })}</span>
              )}
              {edit ? (
                <div className="cal-edit">
                  <TextField value={edit.name} maxLength={EXTERNAL_CALENDAR_NAME_MAX} aria-label={t("Name")} onChange={(e) => setEditing({ ...edit, name: e.target.value })} />
                  <Swatches value={edit.color} onPick={(c) => setEditing({ ...edit, color: c })} />
                  <div className="cal-actions">
                    <Button size="sm" variant="primary" disabled={busy || !edit.name.trim()} onClick={() => void change(calendar.id, { name: edit.name.trim(), color: edit.color })}>{t("Save")}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t("Cancel")}</Button>
                  </div>
                </div>
              ) : (
                <div className="cal-actions">
                  <Button size="sm" variant="ghost" disabled={!online || busy} onClick={() => void refresh(calendar.id)}><RefreshCw size={14} aria-hidden="true" />{t("Update now")}</Button>
                  <Button size="sm" variant="ghost" disabled={!online || busy} onClick={() => setEditing({ id: calendar.id, name: calendar.name, color: calendar.color })}><Pencil size={14} aria-hidden="true" />{t("Rename")}</Button>
                  <Button size="sm" variant="ghost" disabled={!online || busy} onClick={() => void remove(calendar)}><Trash2 size={14} aria-hidden="true" />{t("Remove")}</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {list?.available && !full && (
        <form className="cal-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <TextField value={name} maxLength={EXTERNAL_CALENDAR_NAME_MAX} placeholder={t("Name, such as Work")} aria-label={t("Name")} onChange={(e) => setName(e.target.value)} />
          <TextField value={url} type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder={t("The calendar's iCal link")} aria-label={t("The calendar's iCal link")} onChange={(e) => setUrl(e.target.value)} />
          <Swatches value={color} onPick={setColor} />
          <Button type="submit" variant="primary" size="sm" disabled={!online || adding || !name.trim() || !url.trim()}>{adding ? t("Adding…") : t("Add calendar")}</Button>
        </form>
      )}
      {message && <FieldError>{message}</FieldError>}
    </section>
  );
}
