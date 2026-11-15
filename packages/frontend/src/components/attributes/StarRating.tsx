// Star-rating widget. Two modes:
//   • interactive (onSave given) — used by the schema attribute editor; hover
//     previews, click sets, clicking the current value clears it back to 0.
//   • read-only (onSave omitted) — used by table / gallery cells.
//
// The value is a plain number (value_type 'number' in node_attributes), so the
// existing typed sort / aggregate engine keeps working unchanged — this is
// purely a renderer over a number. Palette: filled = --accent (oxblood),
// empty = --muted; no new colours.

import { useState } from "react";
import "./StarRating.css";
import { useT } from "../../lib/i18n";
import { Pressable } from "../ui";

export function parseRating(value: string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function StarRating({
  value,
  max = 5,
  onSave,
}: {
  value: string | null | undefined;
  max?: number;
  /** Omit for a read-only display (table / gallery cells). The caller owns
   *  the write and its failure report: this widget is on the published site,
   *  which must not load the data layer. */
  onSave?: (next: string) => Promise<void> | void;
}) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const cap = max > 0 ? Math.round(max) : 5;
  const current = Math.min(parseRating(value), cap);
  const interactive = typeof onSave === "function";
  const shown = hover ?? current;

  if (!interactive) {
    // Read-only: render filled/empty stars only, no interaction surface.
    return (
      <span className="star-rating star-rating--ro" aria-label={t("{n} of {cap} stars", { n: current, cap })}>
        {Array.from({ length: cap }, (_, i) => (
          <span key={i} className={i < current ? "star star--on" : "star"}>
            ★
          </span>
        ))}
      </span>
    );
  }

  return (
    <span
      className="star-rating"
      role="radiogroup"
      aria-label={t("Rating")}
      onMouseLeave={() => setHover(null)}
    >
      {Array.from({ length: cap }, (_, i) => {
        const n = i + 1;
        return (
          <Pressable
            key={i}
            type="button"
            className={n <= shown ? "star star--on" : "star"}
            role="radio"
            aria-checked={n === current}
            aria-label={n > 1 ? t("{n} stars", { n }) : t("1 star")}
            title={`${n} / ${cap}`}
            onMouseEnter={() => setHover(n)}
            onFocus={() => setHover(n)}
            onClick={() => void onSave(n === current ? "" : String(n))}
          >
            ★
          </Pressable>
        );
      })}
      {current > 0 && (
        <Pressable
          type="button"
          className="star-clear"
          title={t("Clear rating")}
          aria-label={t("Clear rating")}
          onClick={() => void onSave("")}
        >
          ×
        </Pressable>
      )}
    </span>
  );
}
