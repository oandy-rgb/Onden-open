// The workspace's calendar clock: which time zone its days are cut in and the
// hour a day starts at (localDay.ts reads them; Settings › Time writes them).
// Owner-only and audited like the other workspace settings. Changing either one
// rewrites nothing — due dates, diary titles and events keep their text; only
// the answer to "what day is it now" moves.

import { q } from "../db.js";
import { db } from "../dbKysely.js";
import type { ActorCtx } from "../types.js";
import { log } from "../logger.js";
import { startPeriodicJob } from "../backgroundJobs.js";
import { mutate, requireActor } from "../spine/mutate.js";
import { assertAuthority } from "../spine/authority.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { afterCommit } from "../spine/txHooks.js";
import { canonicalTimeZone, envDefaultTimeZone, isValidDayStartHour, isValidTimeZone, localDayId, resetDayClock, setDayClock } from "../localDay.js";

/** What the owner stored: `timeZone` null = never chosen (ONDEN_TIMEZONE, then UTC). */
export type WorkspaceTimeSetting = { timeZone: string | null; dayStartHour: number };

export const WORKSPACE_TIME_ZONE_CHANGED = "WORKSPACE_TIME_ZONE_CHANGED";

async function readSetting(workspaceId: string): Promise<WorkspaceTimeSetting> {
  const row = await db.selectFrom("workspaces").select(["time_zone", "day_start_hour"]).where("id", "=", workspaceId).executeTakeFirst();
  if (!row) throw new Error("workspace not found");
  return { timeZone: row.time_zone, dayStartHour: row.day_start_hour };
}

function apply(setting: WorkspaceTimeSetting): void {
  // A stored name this build no longer knows must not take the server down:
  // fall back to the default zone and say so.
  if (setting.timeZone && !isValidTimeZone(setting.timeZone)) {
    log.warn("workspace-time", `stored time zone ${setting.timeZone} is not known; using the default`);
    setDayClock({ timeZone: envDefaultTimeZone(), dayStartHour: setting.dayStartHour });
    return;
  }
  setDayClock({ timeZone: setting.timeZone ?? envDefaultTimeZone(), dayStartHour: setting.dayStartHour });
}

/** Load the workspace's setting into the process clock (boot, and the periodic
 *  reload that lets a second instance follow a change made on the first). */
export async function loadWorkspaceClock(workspaceId: string): Promise<void> {
  try {
    apply(await readSetting(workspaceId));
  } catch (e) {
    log.error("workspace-time", "could not load the workspace clock; keeping the current one", { err: e });
  }
}

export function startWorkspaceClockReload(workspaceId: string, intervalMs = 60_000): void {
  startPeriodicJob({ name: "workspace-time", everyMs: intervalMs }, () => loadWorkspaceClock(workspaceId));
}

/** Back to the unconfigured clock (tests). */
export { resetDayClock };

export type WorkspaceTimeChange = {
  /** A zone name, or null to go back to the server default. Omitted: unchanged. */
  timeZone?: string | null;
  dayStartHour?: number;
};

export class WorkspaceTimeInputError extends Error {}

/** Set the zone and/or the day start hour (owner only). Answers the setting
 *  after the change and what day it makes today; a change that leaves both as
 *  they were writes no event. The process clock changes only once the
 *  transaction has committed. */
export async function setWorkspaceTime(authenticated: ActorCtx | null, workspaceId: string, change: WorkspaceTimeChange) {
  const actor = requireActor(authenticated);
  const timeZone = change.timeZone == null ? change.timeZone : canonicalTimeZone(change.timeZone);
  if (timeZone === null && change.timeZone != null) throw new WorkspaceTimeInputError("time_zone is not a known time zone");
  if (change.dayStartHour !== undefined && !isValidDayStartHour(change.dayStartHour)) throw new WorkspaceTimeInputError("day_start_hour must be a whole hour from 0 to 6");

  const after = await withEventTransaction(workspaceId, async () => {
    const before = await readSetting(workspaceId);
    const next: WorkspaceTimeSetting = {
      timeZone: timeZone === undefined ? before.timeZone : timeZone,
      dayStartHour: change.dayStartHour ?? before.dayStartHour,
    };
    const unchanged = next.timeZone === before.timeZone && next.dayStartHour === before.dayStartHour;
    if (unchanged) {
      await assertAuthority(actor, { kind: "principal_admin" });
      return next;
    }
    await mutate({
      actor,
      workspaceId,
      authority: { kind: "principal_admin" },
      event: {
        type: WORKSPACE_TIME_ZONE_CHANGED,
        targetType: "workspace",
        targetId: workspaceId,
        payload: {
          from: { time_zone: before.timeZone, day_start_hour: before.dayStartHour },
          to: { time_zone: next.timeZone, day_start_hour: next.dayStartHour },
        },
      },
      apply: async () => {
        await q(`UPDATE workspaces SET time_zone = $2, day_start_hour = $3 WHERE id = $1`, [workspaceId, next.timeZone, next.dayStartHour]);
        afterCommit(() => apply(next));
      },
    });
    return next;
  });
  return { time_zone: after.timeZone, day_start_hour: after.dayStartHour, today: localDayId() };
}
