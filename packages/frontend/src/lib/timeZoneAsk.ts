// 旅行時詢問: when the owner's device is in another time zone than the workspace,
// ask once whether to move the workspace's "today" there. Pure rule; the card
// (components/TimeZoneAsk) shows it and lib/workspaceClock changes the zone.
//
// Asked only when ALL hold: the person owns the workspace, is online, has not
// switched the question off, this device zone's offset right now differs from
// the workspace zone's, and this device zone has not been answered yet. A zone
// is "answered" until the device reports another one (the home zone on the way
// back included), so one trip is asked about once.

import { zoneOffsetMinutes } from "./workspaceTime";

export type TimeZoneQuestion = {
  /** "set": the owner never chose a zone, so the question is about setting one;
   *  "change": the workspace has a zone and the device is elsewhere. */
  kind: "set" | "change";
  deviceZone: string;
  /** The zone the workspace's days follow now. */
  workspaceZone: string;
};

export type TimeZoneQuestionInput = {
  isOwner: boolean;
  online: boolean;
  /** 「裝置時區不同時問我」: on unless the owner switched it off. */
  asking: boolean;
  /** Both preferences have reached the server since the page opened, so another
   *  device's answer or switch-off is known before anything is asked. */
  prefsSettled: boolean;
  /** The device zone already answered, if any. */
  answered: string | null;
  deviceZone: string;
  /** The owner's choice (null: never chosen). */
  chosenZone: string | null;
  /** The zone standing in for a never-chosen one (ONDEN_TIMEZONE), if the server has one. */
  defaultZone: string | undefined;
  now?: Date;
};

function offsetOrNull(zone: string, now: Date): number | null {
  try { return zoneOffsetMinutes(zone, now); } catch { return null; }
}

/** Whether the device's zone differs from the workspace's right now. */
export function zonesDiffer(deviceZone: string, workspaceZone: string, now: Date = new Date()): boolean {
  const device = offsetOrNull(deviceZone, now);
  const workspace = offsetOrNull(workspaceZone, now);
  return device !== null && workspace !== null && device !== workspace;
}

/** The question to show, or null. */
export function timeZoneQuestion(i: TimeZoneQuestionInput): TimeZoneQuestion | null {
  const now = i.now ?? new Date();
  const workspaceZone = i.chosenZone ?? i.defaultZone ?? "UTC";
  if (!i.isOwner || !i.online || !i.asking || !i.prefsSettled) return null;
  if (!zonesDiffer(i.deviceZone, workspaceZone, now)) return null;
  if (i.answered === i.deviceZone) return null;
  return { kind: i.chosenZone === null ? "set" : "change", deviceZone: i.deviceZone, workspaceZone };
}
