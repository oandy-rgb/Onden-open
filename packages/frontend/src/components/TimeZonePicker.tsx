import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useT } from "../lib/i18n";
import { isEnterKey, isEscapeKey, isImeComposing } from "../lib/keys";
import { canonicalZone } from "../lib/timeLabels";
import { buildZoneIndex, browseZones, loadZoneDirectory, searchZones, type ZoneDirectory, type ZoneEntry } from "../lib/timeZoneSearch";
import { allTimeZones, zoneLabel } from "../lib/workspaceTime";
import "./TimeZonePicker.css";
import { isListNavKey, stepActive } from "../lib/listNav";
import EmptyState from "./EmptyState";
import { Pressable, TextField, keepFocus } from "./ui";

// The one place a time zone is picked (Settings › Time): a field showing the zone
// in use; focus it and type to filter the list under it (↑/↓ to move, Enter to
// pick, Esc to close). The list is inline, not a ui/Popover: Settings is a modal
// <dialog>, and a popover portalled to <body> sits below its top layer
// (components/ui/Modal.tsx). What typing finds is lib/timeZoneSearch. The list is
// built when it opens and the country and city tables are fetched then, so it is
// usable at once and gains its detail lines a moment later. At most PAGE rows are
// drawn at a time; "Show more" adds another page.

const PAGE = 80;

type Props = {
  /** The zone in use. */
  zone: string;
  /** The browser's own zone, listed near the top. */
  device?: string;
  disabled?: boolean;
  onPick: (zone: string) => void;
};

type Row = { entry: ZoneEntry; heading?: string };

export function TimeZonePicker({ zone, device, disabled, onPick }: Props) {
  const t = useT();
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pages, setPages] = useState(1);
  const [directory, setDirectory] = useState<ZoneDirectory | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void loadZoneDirectory().then((loaded) => { if (live) setDirectory(loaded); }, () => { /* the list works without the extra names */ });
    return () => { live = false; };
  }, [open]);
  const index = useMemo(() => (open ? buildZoneIndex(allTimeZones(), directory) : []), [open, directory]);
  const rows = useMemo<Row[]>(() => {
    if (!open) return [];
    if (query.trim()) return searchZones(index, query).map((entry) => ({ entry }));
    const { suggested, rest } = browseZones(index, { device, chosen: zone });
    return [
      ...suggested.map((entry, i) => ({ entry, heading: i === 0 ? t("Suggested") : undefined })),
      ...rest.map((entry, i) => ({ entry, heading: i === 0 ? t("All time zones") : undefined })),
    ];
  }, [open, index, query, device, zone, t]);
  const shown = rows.slice(0, pages * PAGE);
  const left = rows.length - shown.length;
  const current = Math.min(active, Math.max(shown.length - 1, 0));
  const inUse = canonicalZone(zone);
  const here = device ? canonicalZone(device) : null;

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  const close = () => { setOpen(false); setQuery(""); setActive(0); setPages(1); };
  const pick = (picked: string) => {
    close();
    if (canonicalZone(picked) !== inUse) onPick(picked);
  };

  return (
    <div ref={wrapRef} className="time-zone-picker"
      // Focus leaving the picker (not moving to its own "Show more") closes the list.
      onBlur={(e) => { if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) close(); }}>
      <TextField type="text" className="settings-input time-zone-field" role="combobox" autoComplete="off" spellCheck={false}
        aria-label={t("Time zone")} aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && shown.length > 0 ? `${listId}-${current}` : undefined}
        disabled={disabled}
        placeholder={open ? t("City, country or time zone") : undefined}
        value={open ? query : zoneLabel(zone)}
        onFocus={(e) => { setOpen(true); e.currentTarget.select(); }}
        onClick={() => setOpen(true)}
        onChange={(e) => { setOpen(true); setQuery(e.target.value); setActive(0); setPages(1); }}
        onKeyDown={(e) => {
          if (isImeComposing(e)) return;
          if (isEscapeKey(e)) { if (open) { e.preventDefault(); e.stopPropagation(); close(); } }
          else if (isListNavKey(e.key)) { e.preventDefault(); if (open) setActive(stepActive(e.key, current, shown.length)!); else setOpen(true); }
          else if (isEnterKey(e) && open) { e.preventDefault(); const row = shown[current]; if (row) pick(row.entry.zone); }
        }} />
      <ChevronDown size={14} className="time-zone-chevron" aria-hidden="true" />
      {open && (
        <>
          <div ref={listRef} id={listId} className="time-zone-options" role="listbox" aria-label={t("Time zone")}>
            {shown.length === 0 && <EmptyState size="inline" role="status" title={t("No time zone matches.")} />}
            {shown.map(({ entry, heading }, i) => {
              const key = canonicalZone(entry.zone);
              return (
                <div key={entry.zone} role="presentation">
                  {heading && <div className="time-zone-heading" role="presentation">{heading}</div>}
                  <div id={`${listId}-${i}`} data-index={i} role="option" aria-selected={key === inUse}
                    className={`time-zone-option${i === current ? " active" : ""}${key === inUse ? " in-use" : ""}`}
                    onMouseMove={() => { if (i !== current) setActive(i); }}
                    // Keep focus in the field while a row is pressed.
                    onMouseDown={keepFocus}
                    onClick={() => pick(entry.zone)}>
                    <span className="time-zone-option-main">
                      <span className="time-zone-option-label">{entry.label}</span>
                      {entry.detail && <span className="time-zone-option-detail">{entry.detail}</span>}
                    </span>
                    {key === here && <span className="time-zone-option-tag">{t("This device")}</span>}
                    {key === inUse && <span className="time-zone-option-tag">{t("In use")}</span>}
                  </div>
                </div>
              );
            })}
          </div>
          {left > 0 && (
            <div className="time-zone-more">
              <span>{t("{n} more time zones. Keep typing to narrow the list.", { n: left })}</span>
              <Pressable type="button" onMouseDown={keepFocus} onClick={() => setPages((n) => n + 1)}>{t("Show more")}</Pressable>
            </div>
          )}
        </>
      )}
    </div>
  );
}
