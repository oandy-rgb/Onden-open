import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { classNames } from "../../lib/utils";
import { observeSize } from "../../lib/observeSize";
import { Pressable } from "./Pressable";
import "./FilterChips.css";

// One row of pressable filter tags that picks what a list shows: 全部 and each feed, tag or person.
//   <FilterChips label={t("Feeds")} value={active} onChange={setActive}
//     options={[{ value: "", label: t("All"), count: 3 }, { value: id, label: title }]} trailing={<Pressable …/>} />
// Any number of options: the row scrolls sideways and fades at an edge that has more behind it.
// Up to five fixed words (a setting, a display choice) are a Segmented instead; a read-only label is a Chip.

export type FilterChipOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** A small number after the label (unread, matches); 0 or absent draws nothing. */
  count?: number;
  title?: string;
  /** A long press / right click on this tag (e.g. open its settings). */
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
};

type Props<T extends string> = {
  /** Accessible name of the row (already translated). */
  label: string;
  value: T | null;
  options: ReadonlyArray<FilterChipOption<T>>;
  onChange: (value: T) => void;
  /** A button after the row that does not scroll with it (manage, add). */
  trailing?: ReactNode;
  className?: string;
};

type Fade = "none" | "start" | "end" | "both";
const fadeOf = (el: HTMLElement): Fade => {
  const start = el.scrollLeft > 1;
  const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  return start && end ? "both" : start ? "start" : end ? "end" : "none";
};

export function FilterChips<T extends string>({ label, value, options, onChange, trailing, className }: Props<T>) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState<Fade>("none");
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const update = () => setFade(fadeOf(row));
    update();
    row.addEventListener("scroll", update, { passive: true });
    const stop = observeSize(row, update);
    return () => { row.removeEventListener("scroll", update); stop(); };
  }, [options.length]);
  return (
    <div className={classNames("ui-filter-chips", className)} role="toolbar" aria-label={label}>
      <div ref={rowRef} className="ui-filter-chips__row" data-fade={fade}>
        {options.map((o) => (
          <Pressable key={o.value} className="ui-filter-chip" aria-pressed={value === o.value} data-value={o.value}
            title={o.title} onClick={() => onChange(o.value)}
            onContextMenu={o.onContextMenu ? (e) => { e.preventDefault(); o.onContextMenu!(e); } : undefined}>
            <span className="ui-filter-chip__label">{o.label}</span>
            {o.count ? <span className="ui-filter-chip__count">{o.count}</span> : null}
          </Pressable>
        ))}
      </div>
      {trailing}
    </div>
  );
}
