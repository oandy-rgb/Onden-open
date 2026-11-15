// Changing the workspace's calendar clock — its zone and/or the hour a day
// starts at — from anywhere (Settings › Time, the travel question). One path,
// so every entry asks the same question and says the same thing afterwards:
//
//   • A change that moves "today" to another day is confirmed first, with both
//     dates; nothing is stored until the person agrees. A change that leaves
//     today where it is just happens.
//   • The server decides (workspaceWriter.setTime); nothing shows as changed
//     here before it accepts, and a refusal or a lost connection is reported by
//     the write itself.
//   • Afterwards a toast offers 「改回」, which puts the earlier values back.
//
// Only the owner may change it (the server refuses anyone else).

import { addToast, getAppState } from "./appStore";
import { workspaceWriter } from "./data";
import { t } from "./i18n";
import { todayId } from "./localDate";
import { dayOnClock, hourLabel, shortDay, workspaceZoneOf, zoneName } from "./workspaceTime";

export type ClockChange = { timeZone?: string | null; dayStartHour?: number };

/** "changed": the server took it. "cancelled": the person said no. "failed":
 *  not stored (already reported). "unchanged": it was already so. */
export type ClockChangeResult = "changed" | "cancelled" | "failed" | "unchanged";

/** The clock as the workspace holds it now. `timeZone` is what the person
 *  chose (null: never), not what stands in for it. */
function current() {
  const workspace = getAppState().data.workspace;
  return { timeZone: workspace.time_zone ?? null, dayStartHour: workspace.day_start_hour ?? 0 };
}

/** What to ask before the change, or null when today stays the same day. */
function confirmMessage(change: ClockChange, now: Date): string | null {
  const before = current();
  const zone = change.timeZone === undefined ? before.timeZone : change.timeZone;
  const hour = change.dayStartHour ?? before.dayStartHour;
  // The zone that stands in when the owner has chosen none: the server's own.
  const effective = zone ?? workspaceZoneOf({ timezone: getAppState().data.timezone }) ?? "UTC";
  // "Today" as the app shows it now, against what the new clock would make it.
  const from = todayId(now);
  const to = dayOnClock(now, effective, hour);
  if (from === to) return null;
  const vars = { after: shortDay(to), before: shortDay(from) };
  if (change.timeZone !== undefined && change.timeZone !== before.timeZone) {
    return t("After switching to {place} time, today will be {after} (it was {before}). Your notes and tasks are not changed; only when the date switches.", { ...vars, place: zoneName(effective) });
  }
  return t("After the day starts at {hour}, today will be {after} (it was {before}). Your notes and tasks are not changed; only when the date switches.", { ...vars, hour: hourLabel(hour) });
}

/** Make the change: confirm when it moves today, store it, offer 「改回」. */
export async function changeWorkspaceClock(
  change: ClockChange,
  { now = new Date(), confirm }: { now?: Date; /** Asks the person (components/workspaceClockChange wires the app's dialog). */ confirm: (message: string) => Promise<boolean> },
): Promise<ClockChangeResult> {
  const before = current();
  const sameZone = change.timeZone === undefined || change.timeZone === before.timeZone;
  const sameHour = change.dayStartHour === undefined || change.dayStartHour === before.dayStartHour;
  if (sameZone && sameHour) return "unchanged";

  const message = confirmMessage(change, now);
  if (message && !(await confirm(message))) return "cancelled";

  try {
    const { previous } = await workspaceWriter.setTime(change, getAppState().online);
    addToast(t("Time settings changed."), "success", {
      label: t("Change back"),
      onClick: () => {
        workspaceWriter.setTime({ timeZone: previous.timeZone, dayStartHour: previous.dayStartHour }, getAppState().online)
          .then(() => addToast(t("Time settings changed back."), "success"))
          .catch(() => { /* already reported by the write */ });
      },
    });
    return "changed";
  } catch {
    return "failed"; // the write reported it
  }
}
