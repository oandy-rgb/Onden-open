import type { CSSProperties } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "../../lib/i18n";
import { Pressable } from "../ui";
import type { ActivityDay } from "@onden/contract";

/** "10/24" from a YYYY-MM-DD workspace day. */
export function monthDay(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

type Props = {
  days: ActivityDay[];
  selected: string | null;
  /** The agent's name for the legend; "AI" when there are several or none. */
  agentLabel: string;
  /** Show this day in the list. */
  onSelect: (date: string) => void;
  /** Move the window 14 days back / forward; forward is off when the window ends today. */
  onEarlier: () => void;
  onLater: (() => void) | null;
};

/** Fourteen stacked bars: people's edits below, AI's above. A bar's height is the square root of
 *  its day's edits, so one busy day does not flatten the rest; a day with edits is at least
 *  4px tall, a quiet day is a faint baseline. Every day is a button that shows it in the list. */
export default function WorkspaceHistoryChart({ days, selected, agentLabel, onSelect, onEarlier, onLater }: Props) {
  const t = useT();
  const peak = Math.max(1, ...days.map((d) => d.you + d.agents));
  const range = days.length > 0 ? `${monthDay(days[0]!.date)} – ${monthDay(days[days.length - 1]!.date)}` : "";
  return (
    <div className="wh-chart">
      <div className="wh-chart-head">
        <Pressable type="button" className="wh-chart-nav wh-touch" aria-label={t("Show the 14 days before")} onClick={onEarlier}>
          <ChevronLeft size={16} aria-hidden="true" />
        </Pressable>
        <span className="wh-chart-range">{range}</span>
        <Pressable type="button" className="wh-chart-nav wh-touch" aria-label={t("Show the 14 days after")} disabled={!onLater} onClick={() => onLater?.()}>
          <ChevronRight size={16} aria-hidden="true" />
        </Pressable>
        <div className="wh-legend" aria-hidden="true">
          <span><i className="wh-swatch wh-you" />{t("You")}</span>
          <span><i className="wh-swatch wh-ai" />{agentLabel}</span>
        </div>
      </div>
      <div className="wh-bars" role="group" aria-label={t("Edits per day")}>
        {days.map((d) => {
          const total = d.you + d.agents;
          return (
            <div key={d.date} className="wh-col">
              <Pressable
                type="button"
                className={"wh-bar-btn" + (d.date === selected ? " selected" : "")}
                aria-label={t("{date}, {n} edits", { date: monthDay(d.date), n: total })}
                aria-pressed={d.date === selected}
                onClick={() => onSelect(d.date)}
              >
                {total > 0 ? (
                  <span className="wh-stack" style={{ "--wh-h": `${Math.sqrt(total / peak) * 100}%` } as CSSProperties}>
                    {d.agents > 0 && <span className="wh-seg wh-ai" style={{ "--wh-grow": d.agents } as CSSProperties} />}
                    {d.you > 0 && <span className="wh-seg wh-you" style={{ "--wh-grow": d.you } as CSSProperties} />}
                  </span>
                ) : (
                  <span className="wh-baseline" />
                )}
              </Pressable>
              <span className="wh-day-num">{Number(d.date.slice(8, 10))}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
