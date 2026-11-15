// How a DayItem reads in the day views: its title (a merged run of edits has no
// title of its own) and its time ("10:40–11:30"). Words only; never an id.

import type { DayItem } from "@onden/markdown";
import { clockLabel } from "../../../lib/dayWindow";
import { displayTitle } from "../../../lib/noteLabel";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function itemTitle(item: DayItem, t: Translate): string {
  if (item.kind === "edit" && (item.count ?? 1) > 1) return t("Edited {n} notes", { n: item.count! });
  // A focus with no task has no name of its own; the one still running says so.
  if (item.kind === "focus") return item.title ? displayTitle(item.title) : item.live ? t("Focusing") : t("Focus");
  return displayTitle(item.title);
}

/** "10:40" or "10:40–11:30"; empty for an item with no time. */
export function itemTimeText(item: DayItem): string {
  if (!item.at) return "";
  return item.until ? `${clockLabel(item.at)}–${clockLabel(item.until)}` : clockLabel(item.at);
}
