// Fetching a calendar, and the 15-minute pass that keeps every switched-on one fresh.
//
//   • The address is read from its ciphertext only here, handed to safeFetch (the
//     repo's one outbound gate: http/https only, refuses private/local/link-local
//     addresses at connect time and on every redirect, timeout, size cap), and
//     dropped. It is never logged: failures log the calendar id and a short code.
//   • Only a window of days is kept: RANGE_PAST_DAYS back, RANGE_FUTURE_DAYS ahead.
//   • A failed fetch keeps the last good events (so an offline calendar server
//     does not empty the timeline) and records why, as a code the page words.
//   • Manual refresh is limited to one per calendar per MANUAL_COOLDOWN_MS; the
//     pass skips a calendar tried in the last PASS_MIN_AGE_MS.

import { startPeriodicJob } from "../../backgroundJobs.js";
import { log } from "../../logger.js";
import { isTest } from "../../config.js";
import { addDays, localDayId } from "../../localDay.js";
import { safeFetch, SafeFetchError } from "../../services/safeFetch.js";
import { workspaceHasModule } from "../../services/workspaceModules.js";
import { RateLimitError } from "../../services/agentTools/index.js";
import { expandCalendar } from "./ical.js";
import { dueCalendars, lastAttemptAt, loadCalendarUrl, saveFetchResult, type FetchOutcome } from "./store.js";

export const MODULE_ID = "external_calendars";
export const RANGE_PAST_DAYS = 30;
export const RANGE_FUTURE_DAYS = 180;
export const PASS_INTERVAL_MS = 15 * 60_000;
const PASS_MIN_AGE_MS = 10 * 60_000;
const MANUAL_COOLDOWN_MS = 60_000;
const MAX_BYTES = 5 * 1024 * 1024;

type TextFetcher = (url: string) => Promise<{ status: number; text: string }>;
let fetchOverride: TextFetcher | null = null;

/** Test seam (NODE_ENV=test only): replaces the network. */
export function __setCalendarFetchForTests(fn: TextFetcher | null): void {
  if (!isTest()) return;
  fetchOverride = fn;
}

async function download(url: string): Promise<{ status: number; text: string }> {
  if (fetchOverride) return fetchOverride(url);
  const res = await safeFetch(url, { timeoutMs: 10_000, maxBytes: MAX_BYTES, maxRedirects: 3, headers: { Accept: "text/calendar, text/plain;q=0.5, */*;q=0.1" } });
  return { status: res.status, text: res.text };
}

export async function fetchCalendar(url: string, now = new Date()): Promise<FetchOutcome> {
  let body: { status: number; text: string };
  try {
    body = await download(url);
  } catch (e) {
    if (e instanceof SafeFetchError) {
      if (e.code === "forbidden_address" || e.code === "bad_protocol") return { ok: false, reason: "blocked" };
      if (e.code === "too_large") return { ok: false, reason: "too_large" };
    }
    return { ok: false, reason: "unreachable" };
  }
  if (body.status < 200 || body.status >= 300) return { ok: false, reason: "unreachable" };
  const today = localDayId(now);
  try {
    const instances = expandCalendar(body.text, {
      from: new Date(`${addDays(today, -RANGE_PAST_DAYS)}T00:00:00Z`),
      to: new Date(`${addDays(today, RANGE_FUTURE_DAYS)}T23:59:59Z`),
    });
    return { ok: true, instances };
  } catch {
    return { ok: false, reason: "not_calendar" };
  }
}

/** Fetch one calendar now and store the result. */
export async function refreshCalendar(workspaceId: string, id: string): Promise<FetchOutcome["ok"]> {
  const url = await loadCalendarUrl(id);
  if (!url) return false;
  const outcome = await fetchCalendar(url);
  await saveFetchResult(workspaceId, id, outcome);
  if (!outcome.ok) log.warn("external_calendars", "fetch failed", { calendar: id, reason: outcome.reason });
  return outcome.ok;
}

/** The person pressed 更新: refuse a second press within a minute. */
export async function refreshByPerson(workspaceId: string, actorId: string, id: string): Promise<boolean | "missing"> {
  const last = await lastAttemptAt(actorId, id);
  if (last === undefined) return "missing";
  const wait = last ? MANUAL_COOLDOWN_MS - (Date.now() - last.getTime()) : 0;
  if (wait > 0) throw new RateLimitError(Math.ceil(wait / 1000), "refreshed a moment ago");
  return refreshCalendar(workspaceId, id);
}

/** One pass: every due calendar in a workspace that still has the module on. */
export async function refreshDueCalendars(): Promise<number> {
  let done = 0;
  const on = new Map<string, boolean>();
  for (const cal of await dueCalendars(PASS_MIN_AGE_MS)) {
    if (!on.has(cal.workspace_id)) on.set(cal.workspace_id, await workspaceHasModule(cal.workspace_id, MODULE_ID));
    if (!on.get(cal.workspace_id)) continue;
    try {
      await refreshCalendar(cal.workspace_id, cal.id);
      done++;
    } catch (e) {
      // Not the address: only the id and the kind of failure.
      log.error("external_calendars", "refresh crashed", { calendar: cal.id, err: e instanceof Error ? e.name : "error" });
    }
  }
  return done;
}

/** Every 15 minutes; the first pass runs shortly after boot, so a server that was
 *  down catches up at once. exclusive: one process runs it at a time. */
export function startCalendarScheduler(): void {
  startPeriodicJob({ name: "external-calendars", everyMs: PASS_INTERVAL_MS, runFirstAfterMs: 10_000, exclusive: true }, async () => {
    await refreshDueCalendars().catch((e) => log.error("external_calendars", "pass failed", { err: e instanceof Error ? e.name : "error" }));
  });
}
