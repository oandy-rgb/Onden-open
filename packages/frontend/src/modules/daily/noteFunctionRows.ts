import { CalendarDays } from "lucide-react";
import { dayNoteDate } from "@onden/markdown";
import { t, tn } from "../../lib/i18n";
import { noteNeighborhood } from "../../lib/noteNeighborhood";
import { dateLabel } from "../../lib/timeLabels";
import type { NoteFunctionEnv, NoteFunctionRow } from "../types";

// Noon UTC: the same calendar day in any zone the label may be read in.
const dayText = (date: string) => dateLabel(`${date}T12:00:00Z`, "short", "UTC");

/** The 「日記」 row of the 「功能」 tab: the days whose diary links to this note (its backlinks that are day
 *  notes), newest first. No diary mentions it, no row. */
export default function dailyNoteFunctionRows({ node, nodes, edges, nav }: NoteFunctionEnv): NoteFunctionRow[] {
  if (dayNoteDate(node)) return [];
  const seen = new Set<string>();
  const days = noteNeighborhood(node, nodes, edges).relations.flatMap((relation) => {
    const date = relation.direction === "in" && relation.plainLink ? dayNoteDate(relation.node) : null;
    if (!date || seen.has(relation.node.id)) return [];
    seen.add(relation.node.id);
    return [{ date, noteId: relation.node.id }];
  }).sort((a, b) => b.date.localeCompare(a.date));
  if (days.length === 0) return [];
  const labels = days.map((day) => dayText(day.date));
  return [{
    id: "daily",
    Icon: CalendarDays,
    name: t("Daily notes"),
    related: true,
    status: tn("Mentioned in the diary of {day}", "Mentioned in {n} days' diaries, latest {day}", labels.length, { day: labels[0]! }),
    badge: days.length > 3 ? { n: days.length } : undefined,
    details: labels,
    jump: { label: t("Go to that day"), run: () => nav.openNote(days[0]!.noteId) },
  }];
}
