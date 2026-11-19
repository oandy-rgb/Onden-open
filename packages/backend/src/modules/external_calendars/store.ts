// External calendars: the rows (migration 160) and the one place that writes them.
//
// Personal by construction: every statement is keyed by actor_id, nothing here is
// space-scoped, and no domain event is recorded (a subscription is a setting with
// no history to restore). Writes run under the workspace event lock like the RSS
// settings (spine/eventTransaction); the address is stored only as ciphertext.

import { q, allowUnstampedWrite } from "../../db.js";
import { mutatePersonal } from "../../spine/mutate.js";
import { isTemporarySessionActor, personalDataOwnerId } from "../../spine/authority.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { sealText, openText } from "../../services/aiCredentials.js";
import { dayClock, localDayId, sqlDayStart, addDays } from "../../localDay.js";
import { StatusError } from "../../statusError.js";
import type { ActorCtx } from "../../types.js";
import type { CalendarInstance } from "./ical.js";

export type CalendarRow = {
  id: string; name: string; color: string; host: string; enabled: boolean;
  last_fetched_at: string | null; last_error: string | null;
};

const COLS = `id::text, name, color, url_host AS host, enabled, last_fetched_at, last_error`;

/** One person may keep this many calendars: each is a fetch every 15 minutes. */
export const MAX_CALENDARS_PER_PERSON = 10;

/** What a temporary session reads of a calendar: no address host and no fetch error (those serve the settings page it cannot use; the
 *  error text can name the address). The address itself is stored sealed and is never in any answer. */
function forReader(actor: ActorCtx, row: CalendarRow): CalendarRow {
  return isTemporarySessionActor(actor) ? { ...row, host: "", last_error: null } : row;
}

/** What a temporary session reads of an EVENT: the time and that the person is busy, nothing else. A location or a description often carries a meeting link and its password
 *  (a value that is a capability), a title says what the person does, and the calendar is not limited by space: a 62-day window at a time reads the whole history. The calendar's
 *  own name and colour stay. Held back until the owner decides whether a session may see more (docs/architecture/proposals/sessions-reads-own-2026-11-17.md). */
const BUSY_TITLE = "忙碌";
function eventForReader(actor: ActorCtx, event: DayEvent): DayEvent {
  return isTemporarySessionActor(actor) ? { ...event, title: BUSY_TITLE, location: "", description: "" } : event;
}

/** The calendars of the person the caller reads for (personalDataOwnerId: a session reads its person's). */
export async function listCalendars(actor: ActorCtx): Promise<CalendarRow[]> {
  const rows = (await q<CalendarRow>(`SELECT ${COLS} FROM external_calendars WHERE actor_id = $1 ORDER BY created_at, id`, [personalDataOwnerId(actor)])).rows;
  return rows.map((row) => forReader(actor, row));
}

export async function getCalendar(actor: ActorCtx, id: string): Promise<CalendarRow | null> {
  const row = (await q<CalendarRow>(`SELECT ${COLS} FROM external_calendars WHERE actor_id = $1 AND id = $2`, [personalDataOwnerId(actor), id])).rows[0];
  return row ? forReader(actor, row) : null;
}

export async function addCalendar(
  workspaceId: string, actor: ActorCtx,
  input: { id: string; name: string; color: string; href: string; host: string },
): Promise<CalendarRow | "limit"> {
  return mutatePersonal({ actor, workspaceId, apply: async ({ actor: current }) => {
    const count = Number((await q<{ n: string }>(`SELECT count(*) AS n FROM external_calendars WHERE actor_id = $1`, [current.id])).rows[0]!.n);
    if (count >= MAX_CALENDARS_PER_PERSON) return "limit" as const;
    const saved = (await q<CalendarRow>(
      `INSERT INTO external_calendars (id, workspace_id, actor_id, name, color, url_ciphertext, url_host)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET id = external_calendars.id WHERE external_calendars.actor_id = EXCLUDED.actor_id
       RETURNING ${COLS}`,
      [input.id, workspaceId, current.id, input.name, input.color, sealText(input.href, input.id), input.host])).rows[0];
    // The id belongs to someone else's calendar: say nothing about it.
    if (!saved) throw new StatusError(404, "not_found");
    return saved;
  } });
}

export async function changeCalendar(
  workspaceId: string, actor: ActorCtx, id: string,
  patch: { name?: string; color?: string; enabled?: boolean },
): Promise<CalendarRow | null> {
  return mutatePersonal({ actor, workspaceId, apply: async ({ actor: current }) => {
    return (await q<CalendarRow>(
      `UPDATE external_calendars SET name = COALESCE($3, name), color = COALESCE($4, color), enabled = COALESCE($5, enabled)
        WHERE actor_id = $1 AND id = $2 RETURNING ${COLS}`,
      [current.id, id, patch.name ?? null, patch.color ?? null, patch.enabled ?? null])).rows[0] ?? null;
  } });
}

export async function removeCalendar(workspaceId: string, actor: ActorCtx, id: string): Promise<boolean> {
  return mutatePersonal({ actor, workspaceId, apply: async ({ actor: current }) => {
    return ((await q(`DELETE FROM external_calendars WHERE actor_id = $1 AND id = $2`, [current.id, id])).rowCount ?? 0) > 0;
  } });
}

/** The saved address, for the fetch only. Never put its result in a response, a log or an event. */
export async function loadCalendarUrl(id: string): Promise<string | null> {
  const row = (await q<{ url_ciphertext: Buffer }>(`SELECT url_ciphertext FROM external_calendars WHERE id = $1`, [id])).rows[0];
  return row ? openText(row.url_ciphertext, id) : null;
}

/** Calendars the 15-minute pass should fetch: switched on, not tried in the last `minAgeMs`. */
export async function dueCalendars(minAgeMs: number): Promise<Array<{ id: string; workspace_id: string }>> {
  return (await q<{ id: string; workspace_id: string }>(
    `SELECT id::text, workspace_id::text FROM external_calendars
      WHERE enabled AND (last_attempt_at IS NULL OR last_attempt_at <= now() - make_interval(secs => $1))
      ORDER BY last_attempt_at NULLS FIRST LIMIT 200`, [minAgeMs / 1000])).rows;
}

/** The calendar's owner and when it was last tried, for the manual-refresh cooldown. */
export async function lastAttemptAt(actorId: string, id: string): Promise<Date | null | undefined> {
  const row = (await q<{ t: Date | null }>(`SELECT last_attempt_at AS t FROM external_calendars WHERE actor_id = $1 AND id = $2`, [actorId, id])).rows[0];
  return row ? row.t : undefined;
}

export type FetchOutcome = { ok: true; instances: CalendarInstance[] } | { ok: false; reason: "unreachable" | "not_calendar" | "too_large" | "blocked" };

// The columns a fetch writes (last_attempt_at, last_fetched_at, last_error) are the fetching node's own state, not
// stamped data (causal-stamps proposal §4.1: "事件每次抓取整批換，不複製"), and a background pass has no person to author a stamp.
const FETCH_STATE_REASON = "calendar fetch state belongs to the node that fetched it";

/** Record what a fetch found. A good fetch replaces the calendar's events whole; a failed one keeps the last good events and only notes the reason. */
export async function saveFetchResult(workspaceId: string, id: string, outcome: FetchOutcome): Promise<void> {
  await withEventTransaction(workspaceId, async () => {
    if (!outcome.ok) {
      await allowUnstampedWrite(FETCH_STATE_REASON, () => q(`UPDATE external_calendars SET last_attempt_at = now(), last_error = $2 WHERE id = $1`, [id, outcome.reason]));
      return;
    }
    const alive = await allowUnstampedWrite(FETCH_STATE_REASON, () => q(`UPDATE external_calendars SET last_attempt_at = now(), last_fetched_at = now(), last_error = NULL WHERE id = $1 RETURNING id`, [id]));
    if (!alive.rows.length) return; // deleted while the fetch ran
    await q(`DELETE FROM external_calendar_events WHERE calendar_id = $1`, [id]);
    const rows = outcome.instances;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const params: unknown[] = [id];
      const values = chunk.map((e) => {
        params.push(e.key, e.title, e.location, e.description, e.allDay, e.startsAt, e.endsAt, e.startDate, e.endDate);
        const b = params.length - 8;
        return `($1, $${b}, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::timestamptz, $${b + 6}::timestamptz, $${b + 7}::date, $${b + 8}::date)`;
      });
      await q(
        `INSERT INTO external_calendar_events (calendar_id, instance_key, title, location, description, all_day, starts_at, ends_at, start_date, end_date)
         VALUES ${values.join(", ")} ON CONFLICT DO NOTHING`, params);
    }
  });
}

export type DayEvent = {
  id: string; calendar_id: string; calendar_name: string; color: string;
  title: string; location: string; description: string; all_day: boolean;
  starts_at: string; ends_at: string;
  /** Workspace days the event touches: first and last (inclusive). */
  start_day: string; end_day: string;
};

/** The caller's events that touch the workspace days from..to (inclusive), from calendars that are switched on (a session reads its person's). */
export async function eventsBetween(actor: ActorCtx, from: string, to: string): Promise<DayEvent[]> {
  const rows = (await q<{
    calendar_id: string; instance_key: string; name: string; color: string; title: string; location: string; description: string;
    all_day: boolean; starts_at: Date; ends_at: Date; start_date: string | null; end_date: string | null;
  }>(
    `SELECT e.calendar_id::text, e.instance_key, c.name, c.color, e.title, e.location, e.description, e.all_day, e.starts_at, e.ends_at,
            to_char(e.start_date, 'YYYY-MM-DD') AS start_date, to_char(e.end_date, 'YYYY-MM-DD') AS end_date
       FROM external_calendar_events e JOIN external_calendars c ON c.id = e.calendar_id
      WHERE c.actor_id = $1 AND c.enabled
        AND (CASE WHEN e.all_day THEN e.start_date <= $3::date AND e.end_date > $2::date
                  ELSE e.starts_at < ${sqlDayStart("$3::date + 1")} AND e.ends_at >= ${sqlDayStart("$2::date")} END)
      ORDER BY e.starts_at, e.instance_key`, [personalDataOwnerId(actor), from, to])).rows;
  const clock = dayClock();
  return rows.map((r): DayEvent => {
    const startDay = r.all_day ? r.start_date! : localDayId(r.starts_at, clock);
    // The last instant of a timed event is exclusive: one ending exactly at the next day's start stays on the first day.
    const endDay = r.all_day ? addDays(r.end_date!, -1) : localDayId(new Date(Math.max(r.starts_at.getTime(), r.ends_at.getTime() - 1)), clock);
    return eventForReader(actor, {
      id: `${r.calendar_id}:${r.instance_key}`, calendar_id: r.calendar_id, calendar_name: r.name, color: r.color,
      title: r.title, location: r.location, description: r.description, all_day: r.all_day,
      starts_at: r.starts_at.toISOString(), ends_at: r.ends_at.toISOString(), start_day: startDay, end_day: endDay,
    });
  });
}
