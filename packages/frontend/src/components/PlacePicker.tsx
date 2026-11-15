import type { CSSProperties } from "react";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Lock, Users } from "lucide-react";
import { useT } from "../lib/i18n";
import type { PlaceChoice, PlaceGroup } from "../lib/placeGroups";
import { spaceLabel } from "../lib/spaces";
import { containsTitle } from "../lib/noteSearch";
import { Chip, SearchField, keepFocus } from "./ui";
import "./PlacePicker.css";
import EmptyState from "./EmptyState";

// The one screen for "where does this go": search on top, then the places
// grouped by space — each group's top level first, then the notes (or tags)
// that may hold it, as a tree, or flat with the parent's title when searching.
// What is offered is decided by the caller (lib/placeGroups); a pick is
// reported as { spaceId, parentId } and the caller decides what it writes.
//   • "here"   (Move to…): `current` is where the note is now — marked, not pickable;
//   • "chosen" (放在…):    `current` is the choice so far — checked, and may be picked again.
// ↑/↓ move, Enter picks, Esc closes; up to 50 rows, then "type to narrow".

const ROW_LIMIT = 50;
const MAX_INDENT_DEPTH = 3;

type Option = { key: string; group: PlaceGroup; parentId: string | null; title: string; depth: number; hint?: string };

type Props = {
  groups: PlaceGroup[];
  current: PlaceChoice | null;
  currentMark: "here" | "chosen";
  /** Accessible name and placeholder of the search field. */
  searchLabel: string;
  /** Grey line under the search: where it is now. Left out when creating. */
  where?: string;
  /** What each group's top row is called (default 「最上層」): quick capture calls it 收件匣. */
  topLabel?: string;
  onPick: (choice: PlaceChoice) => void;
  onClose: () => void;
};

export function PlacePicker({ groups, current, currentMark, searchLabel, where, topLabel, onPick, onClose }: Props) {
  const t = useT();
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const showHeadings = groups.length > 1;

  const { options, truncated } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Option[] = [];
    let notes = 0;
    let more = false;
    for (const group of groups) {
      const spaceKey = group.space?.id ?? "none";
      const rows: Option[] = [];
      if (!q) rows.push({ key: `${spaceKey}:top`, group, parentId: null, title: topLabel ?? t("Top level"), depth: 0 });
      for (const entry of group.entries) {
        if (q && !containsTitle(q, entry.title)) continue;
        if (notes >= ROW_LIMIT) { more = true; break; }
        notes++;
        rows.push({ key: `${spaceKey}:${entry.parentId}`, group, parentId: entry.parentId, title: entry.title,
          depth: q ? 0 : entry.depth, hint: q ? entry.parentTitle : undefined });
      }
      out.push(...rows);
    }
    return { options: out, truncated: more };
  }, [groups, query, t, topLabel]);

  const isCurrent = (o: Option) => current !== null && current.parentId === o.parentId && current.spaceId === (o.group.space?.id ?? null);
  const index = Math.min(active, Math.max(options.length - 1, 0));
  const choose = (o: Option) => {
    if (isCurrent(o) && currentMark === "here") return;
    onPick({ spaceId: o.group.space?.id ?? null, parentId: o.parentId });
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  return (
    <div className="place-picker">
      <SearchField
        autoFocus
        className="place-picker-input"
        role="combobox"
        label={searchLabel}
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={options.length > 0 ? `${listId}-${index}` : undefined}
        value={query}
        onValueChange={(v) => { setQuery(v); setActive(0); }}
        nav={{ count: options.length, active: index, onActive: setActive, onPick: (i) => { const o = options[i]; if (o) choose(o); } }}
        onEscape={onClose}
      />
      {where && <p className="place-picker-where">{where}</p>}
      {options.length > 0 ? (
        <ul ref={listRef} id={listId} className="place-picker-options" role="listbox" aria-label={t("Where it can go")}>
          {options.map((o, i) => {
            const here = isCurrent(o);
            const space = o.group.space;
            const Icon = space?.kind === "personal" ? Lock : Users;
            return (
              <Fragment key={o.key}>
                {showHeadings && (i === 0 || options[i - 1]!.group !== o.group) && (
                  <li role="presentation" className="place-picker-heading">
                    {space && <><Icon size={12} aria-hidden="true" /> {spaceLabel(space)}</>}
                  </li>
                )}
                <li id={`${listId}-${i}`} data-index={i} role="option"
                  aria-selected={i === index}
                  aria-current={here ? "location" : undefined}
                  aria-disabled={here && currentMark === "here" ? true : undefined}
                  className={["place-picker-row", i === index && "active", here && currentMark === "here" && "is-here"].filter(Boolean).join(" ")}
                  style={{ "--depth": Math.min(o.depth, MAX_INDENT_DEPTH) } as CSSProperties}
                  onMouseMove={() => { if (i !== index) setActive(i); }}
                  // Keep focus in the search field while a row is pressed.
                  onMouseDown={keepFocus}
                  onClick={() => choose(o)}>
                  <span className="place-picker-text">
                    <span className="place-picker-label">{o.title}</span>
                    {o.hint && <span className="place-picker-hint">{o.hint}</span>}
                  </span>
                  {here && currentMark === "here" && <Chip>{t("Current place")}</Chip>}
                  {here && currentMark === "chosen" && <Check size={15} aria-hidden="true" />}
                </li>
              </Fragment>
            );
          })}
        </ul>
      ) : (
        <EmptyState size="inline" role="status" title={t("No places match")} />
      )}
      {truncated && <p className="place-picker-more">{t("Type to narrow the list")}</p>}
    </div>
  );
}
