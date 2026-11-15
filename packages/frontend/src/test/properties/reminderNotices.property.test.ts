// In-app reminders over a random day-to-day life of an agenda (lib/dueSoonNotify.ts as
// hooks/useDueSoonNotifications.ts runs it).
//
// The hook's two steps are copied from it, in its order, with one persisted fired set:
//   tick    fetch the agenda → pendingDueNotices(agenda, fired) → fired = its set, persisted → show
//           → remind()                                                       (every 5 min, and when the tab shows)
//   remind  pendingRemindNotices(held agenda, { ms: Date.now(), wall: nowDateTimeId(), dayStartHour: settings.dayStart }, fired)
//           → fired = its set, persisted → show                              (every 15 s, on the held agenda)
// The set is stored as JSON and read back on a reload, as readFired / writeFired do. The agenda is what
// the server's agenda holds: tasks bucketed by the one rule (@onden/markdown taskBucket) on the workspace
// clock (zone + hour the day starts at), which the test changes in the middle of a run.
//
// Time moves in three ways: "run" (the tab is alive for minutes: checks every 15 s, or every 60 s while
// hidden), "sleep" (a locked phone / closed lid: days can pass with no check), then a tick when it shows.
// Tasks are finished, reopened and retimed on the server between fetches (a retime carries a wall-clock reminder with
// the task, as the server does: scan 10 #11).
//
// The reference is written here, not taken from @onden/markdown reminderMoment: a moment is a wall-clock
// time in the WORKSPACE zone (or an instant); a task's start time on day D at HH:MM is on the calendar day
// D, or D+1 when HH:MM is before the hour the day starts at (04:00 → 02:00 still belongs to yesterday).
//
// Invariants (all hold; each of G2–G4 has a named fixed case besides the random one):
//  G1  a due / overdue notice is shown once per entry into its bucket (and each time a task re-enters it,
//      or gets late); a finished task is never shown; the fired set stays within what the agenda holds;
//      a reminder at a clock time or an instant is never shown before it.
//  G2  each (task, reminder moment) is shown once.
//  G3  a reminder for a task's start time is never shown before that time on the workspace's day.
//  G4  a reminder whose moment has come (and is under the 12 h catch-up old) is shown by the next check.
//
// Replay a failure:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/reminderNotices

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { REMIND_CATCH_UP_MS, dueReminderMoment, reminderKey, taskBucket } from "@onden/markdown";
import { reminderAfterMove } from "@onden/markdown/contract";
import { pendingDueNotices, pendingRemindNotices, type Agenda, type AgendaTask, type DueNotice } from "../../lib/dueSoonNotify";
import { nowDateTimeId, setWorkspaceDayStartSource, setWorkspaceTimeZoneSource, todayId } from "../../lib/localDate";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SLACK_MS = 5_000; // "a few seconds"
const ZONES = ["UTC", "Asia/Taipei", "America/New_York", "Europe/Berlin", "Pacific/Auckland", "America/St_Johns", "Pacific/Kiritimati"];

// ── independent clock reference ──────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDay = (day: string, n: number) => dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY);
const formats = new Map<string, Intl.DateTimeFormat>();
function wallAsUtc(at: number, zone: string): number {
  let f = formats.get(zone);
  if (!f) formats.set(zone, f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
}
/** The instant `zone`'s wall clock reads `wall` (YYYY-MM-DDTHH:MM); null when that wall time does not exist or happens twice. */
function instantOfWall(wall: string, zone: string): number | null {
  const asUtc = Date.parse(`${wall}:00Z`);
  const offsets = new Set([wallAsUtc(asUtc - DAY, zone) - (asUtc - DAY), wallAsUtc(asUtc + DAY, zone) - (asUtc + DAY)]);
  const hits = [...offsets].map((o) => asUtc - o).filter((at) => wallAsUtc(at, zone) === asUtc);
  return hits.length === 1 ? hits[0]! : null;
}

// ── the world ────────────────────────────────────────────────────────────────
type Task = { id: string; status: "todo" | "doing" | "done" | "cancelled"; due_date: string | null; time: string | null; remind_at: string | null };
type Settings = { zone: string; dayStart: number };
type Shown = { notice: DueNotice; at: number; kind: "due" | "remind"; task: Task; settings: Settings };

const timeArb = fc.constantFrom("00:30", "01:00", "02:00", "03:59", "04:00", "05:30", "09:00", "12:00", "18:45", "23:30");
const taskArb = (index: number): fc.Arbitrary<Omit<Task, "due_date" | "remind_at"> & { dueOffset: number | null; remind: { kind: "wall" | "instant" | "start"; dayOffset: number; time: string; shiftMin: number } | null }> => fc.record({
  id: fc.constant(`t${index}`),
  status: fc.constantFrom("todo" as const, "doing" as const),
  dueOffset: fc.option(fc.integer({ min: -3, max: 9 }), { nil: null, freq: 5 }),
  time: fc.option(timeArb, { nil: null }),
  remind: fc.option(fc.record({ kind: fc.constantFrom("wall" as const, "instant" as const, "start" as const), dayOffset: fc.integer({ min: -1, max: 3 }), time: timeArb, shiftMin: fc.integer({ min: -600, max: 600 }) }), { nil: null, freq: 2 }),
});

type Op =
  | { k: "run"; minutes: number; hidden: boolean }
  | { k: "sleep"; hours: number }
  | { k: "reload" }
  | { k: "show" }
  | { k: "finish"; task: number }
  | { k: "reopen"; task: number }
  | { k: "retime"; task: number; what: "due" | "time" | "remind"; by: number }
  | { k: "clock"; zone?: string; dayStart?: number };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ k: fc.constant("run" as const), minutes: fc.integer({ min: 1, max: 12 }), hidden: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("sleep" as const), hours: fc.constantFrom(1, 3, 7, 13, 25, 30, 49, 80) }) },
  { weight: 1, arbitrary: fc.constant({ k: "reload" } as Op) },
  { weight: 1, arbitrary: fc.constant({ k: "show" } as Op) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("finish" as const), task: fc.nat(4) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("reopen" as const), task: fc.nat(4) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("retime" as const), task: fc.nat(4), what: fc.constantFrom("due", "time", "remind"), by: fc.integer({ min: -2, max: 3 }) }) },
  { weight: 2, arbitrary: fc.oneof(fc.record({ k: fc.constant("clock" as const), zone: fc.constantFrom(...ZONES) }), fc.record({ k: fc.constant("clock" as const), dayStart: fc.integer({ min: 0, max: 6 }) })) },
);

const startArb = fc.oneof(
  fc.integer({ min: Date.UTC(2026, 0, 5), max: Date.UTC(2026, 11, 20) }),
  fc.tuple(fc.constantFrom("2026-03-08", "2026-03-29", "2026-04-05", "2026-10-25", "2026-11-01"), fc.integer({ min: -30, max: 30 })).map(([d, h]) => Date.parse(`${d}T00:00:00Z`) + h * HOUR),
);
const worldArb = fc.record({
  start: startArb, settings: fc.record({ zone: fc.constantFrom(...ZONES), dayStart: fc.integer({ min: 0, max: 6 }) }),
  tasks: fc.tuple(taskArb(0), taskArb(1), taskArb(2), taskArb(3), taskArb(4)).chain((ts) => fc.integer({ min: 1, max: 5 }).map((n) => ts.slice(0, n))),
  ops: fc.array(opArb, { minLength: 1, maxLength: 10 }),
  closedInAgenda: fc.boolean(), // a finished task still listed in a bucket: the status flipped between the bucket query and the read
});

type Checks = { green: boolean; once: boolean; startTime: boolean; live: boolean };

/** Builds the tasks from their generated offsets against the start day and zone. */
function build(w: { start: number; settings: Settings; tasks: Array<ReturnType<typeof taskArb> extends fc.Arbitrary<infer T> ? T : never>; ops: Op[]; closedInAgenda: boolean }) {
  const startDay = todayAt(w.start, w.settings);
  const tasks: Task[] = w.tasks.map((t) => {
    const due_date = t.dueOffset === null ? null : addDay(startDay, t.dueOffset);
    let remind_at: string | null = null;
    if (t.remind) {
      const wall = `${addDay(startDay, t.remind.dayOffset)}T${t.remind.time}`;
      if (t.remind.kind === "wall") remind_at = wall;
      // what quick add writes for "提醒我" (decided 2026-11-15): wall-clock text of the start moment; a task with no start time gets the generated wall time
      else if (t.remind.kind === "start") remind_at = due_date !== null && t.time !== null ? `${Number(t.time.slice(0, 2)) < w.settings.dayStart ? addDay(due_date, 1) : due_date}T${t.time}` : wall;
      else {
        const at = instantOfWall(wall, w.settings.zone);
        remind_at = new Date((at ?? Date.parse(`${wall}:00Z`)) + t.remind.shiftMin * MIN).toISOString();
      }
    }
    return { id: t.id, status: t.status, due_date, time: t.time, remind_at };
  });
  return { start: w.start, settings: w.settings, tasks, ops: w.ops, closedInAgenda: w.closedInAgenda };
}
const todayAt = (ms: number, s: Settings) => todayId(new Date(ms), s.zone, s.dayStart);

let settings: Settings = { zone: "UTC", dayStart: 0 };
setWorkspaceTimeZoneSource(() => settings.zone);
setWorkspaceDayStartSource(() => settings.dayStart);
afterAll(() => { vi.useRealTimers(); setWorkspaceTimeZoneSource(() => undefined); setWorkspaceDayStartSource(() => 0); });
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });

/** The independent reading of when a task is to be reminded: { wallText | instant } → the instant, null if there is none or it is ambiguous. */
function referenceMoment(task: Task, s: Settings): { text: string; at: number | null } | null {
  if (task.remind_at) {
    if (/(?:Z|[+-]\d\d:?\d\d)$/.test(task.remind_at)) return { text: task.remind_at, at: Date.parse(task.remind_at) };
    return { text: task.remind_at, at: instantOfWall(task.remind_at.slice(0, 16), s.zone) };
  }
  if (task.time && task.due_date) {
    // The day D lasts from D HH:00 (the start hour) to D+1 HH:00: a time before the start hour is on the next calendar day.
    const calendarDay = task.time < `${pad(s.dayStart)}:00` ? addDay(task.due_date, 1) : task.due_date;
    return { text: `${calendarDay}T${task.time}`, at: instantOfWall(`${calendarDay}T${task.time}`, s.zone) };
  }
  return null;
}

function play(w: ReturnType<typeof build>, checks: Checks): void {
  settings = { ...w.settings };
  let now = w.start;
  vi.setSystemTime(now);
  const tasks = w.tasks.map((t) => ({ ...t }));
  const trace: string[] = [];
  const fail = (m: string) => `${m}\nsteps:\n${trace.join("\n")}`;
  const where = () => `${new Date(now).toISOString()} (${settings.zone}, day starts ${settings.dayStart}h)`;

  // the device
  let persisted = JSON.stringify([]);
  let fired = new Set<string>(JSON.parse(persisted));
  let held: Agenda | null = null;
  let heldTasks: Task[] = [];
  const shown: Shown[] = [];

  const agendaNow = (): { agenda: Agenda; snapshot: Task[] } => {
    const today = todayId(new Date(now));
    const buckets: Record<string, AgendaTask[]> = {};
    const snapshot: Task[] = [];
    for (const t of tasks) {
      const closed = t.status === "done" || t.status === "cancelled";
      if (closed && !w.closedInAgenda) continue;
      const bucket = taskBucket({ when: t.due_date, status: closed ? "todo" : t.status }, today);
      (buckets[bucket] ??= []).push({ id: t.id, node_id: null, node_title: "", title: t.id, status: t.status, due_date: t.due_date, recur: null, bucket, remind_at: t.remind_at, time: t.time });
      snapshot.push({ ...t });
    }
    return { agenda: { buckets, count: snapshot.length }, snapshot };
  };
  const show = (notices: DueNotice[]) => {
    for (const notice of notices) {
      const task = heldTasks.find((t) => t.id === notice.taskId)!;
      shown.push({ notice, at: now, kind: notice.key.startsWith("remind:") ? "remind" : "due", task, settings: { ...settings } });
      trace.push(`  show ${notice.key} @ ${where()}`);
    }
  };

  // episodes: a due notice is owed once per run of fetches that see the task in the same bucket
  const lastBucket = new Map<string, string | null>();
  const episode = new Map<string, number>();
  const dueShown = new Map<string, number>();
  const episodeKey = (id: string, bucket: string) => `${id}|${bucket}|${episode.get(id) ?? 0}`;

  const remind = () => {
    if (!held) return;
    const { notices, firedKeys } = pendingRemindNotices(held, { ms: Date.now(), wall: nowDateTimeId(), dayStartHour: settings.dayStart }, fired);
    if (notices.length > 0 || firedKeys.size !== fired.size) { fired = firedKeys; persisted = JSON.stringify([...fired]); }
    show(notices);
  };
  const tick = () => {
    const { agenda, snapshot } = agendaNow();
    held = agenda; heldTasks = snapshot;
    const today = todayId(new Date(now));
    for (const t of tasks) {
      const open = t.status === "todo" || t.status === "doing";
      const bucket = open ? taskBucket({ when: t.due_date, status: t.status }, today) : null;
      const now_ = bucket === "overdue" || bucket === "today" ? bucket : null;
      if (lastBucket.get(t.id) !== now_) { episode.set(t.id, (episode.get(t.id) ?? 0) + 1); lastBucket.set(t.id, now_); }
    }
    const { notices, firedKeys } = pendingDueNotices(agenda, fired);
    fired = firedKeys; persisted = JSON.stringify([...fired]);
    show(notices);
    for (const n of notices) {
      const key = episodeKey(n.taskId, n.key.split(":")[0]!);
      dueShown.set(key, (dueShown.get(key) ?? 0) + 1);
    }
    remind();
  };

  const verify = (afterFetch: boolean) => {
    const today = todayId(new Date(now));
    if (checks.green) {
      // a finished task is never shown
      for (const s of shown) expect(s.task.status === "done" || s.task.status === "cancelled", fail(`G1 a finished task was shown: ${s.notice.key}`)).toBe(false);
      // a due notice once per entry
      for (const [key, n] of dueShown) expect(n, fail(`G1 due notice shown ${n} times in one entry: ${key}`)).toBeLessThanOrEqual(1);
      if (afterFetch) {
        for (const t of tasks) {
          const bucket = (t.status === "todo" || t.status === "doing") ? taskBucket({ when: t.due_date, status: t.status }, today) : null;
          if (bucket === "overdue" || bucket === "today") expect(dueShown.get(episodeKey(t.id, bucket)) ?? 0, fail(`G1 ${t.id} is ${bucket} and no notice was shown for it`)).toBe(1);
        }
      }
      // the fired set stays bounded: a due key per task the agenda holds, and a reminder key while its task is in the agenda, or its moment can still be caught up
      const dueKeys = [...fired].filter((k) => !k.startsWith("remind:"));
      expect(dueKeys.length, fail(`G1 fired set holds ${dueKeys.length} due keys for ${held?.count ?? 0} tasks: ${dueKeys.join(" ")}`)).toBeLessThanOrEqual(held?.count ?? 0);
      for (const k of fired) {
        if (!k.startsWith("remind:") || (held && Object.values(held.buckets).flat().some((t) => k.startsWith(`remind:${t.id}:`)))) continue;
        const text = k.split(":").slice(2).join(":");
        const at = /(?:Z|[+-]\d\d:?\d\d)$/.test(text) ? Date.parse(text) : Date.parse(`${text.slice(0, 16)}:00Z`) - (wallAsUtc(now, settings.zone) - now);
        expect(now - at, fail(`G1 fired set keeps ${k}, whose task has left the agenda and whose moment is older than the catch-up window`)).toBeLessThanOrEqual(REMIND_CATCH_UP_MS + 2 * HOUR);
      }
      // a reminder at a clock time or an instant is never shown before it
      for (const s of shown) {
        if (s.kind !== "remind" || !s.task.remind_at) continue;
        const moment = referenceMoment(s.task, s.settings);
        if (moment?.at != null) expect(s.at, fail(`G1 ${s.notice.key} shown ${(moment.at - s.at) / MIN} min before ${moment.text} (${s.settings.zone})`)).toBeGreaterThanOrEqual(moment.at - SLACK_MS);
      }
    }
    if (checks.once) {
      const seen = new Map<string, number>();
      for (const s of shown) if (s.kind === "remind") seen.set(s.notice.key, (seen.get(s.notice.key) ?? 0) + 1);
      for (const [key, n] of seen) expect(n, fail(`G2 reminder ${key} shown ${n} times`)).toBe(1);
    }
    if (checks.startTime) {
      for (const s of shown) {
        if (s.kind !== "remind" || s.task.remind_at) continue;
        const moment = referenceMoment(s.task, s.settings);
        if (moment?.at != null) expect(s.at, fail(`G3 start-time reminder ${s.notice.key} shown ${((moment.at - s.at) / HOUR).toFixed(1)} h before ${moment.text} (${s.settings.zone}, day starts ${s.settings.dayStart}h)`)).toBeGreaterThanOrEqual(moment.at - SLACK_MS);
      }
    }
    if (checks.live && afterFetch) {
      for (const t of tasks) {
        if (t.status !== "todo" && t.status !== "doing") continue;
        const moment = referenceMoment(t, settings);
        if (!moment || moment.at == null) continue;
        const ago = now - moment.at;
        // a moment that came (and is not near the 12 h edge) must have been shown, once, by now
        if (ago >= SLACK_MS && ago <= REMIND_CATCH_UP_MS - 2 * MIN - HOUR /* wall-clock compare: a daylight-saving change in between moves the edge by an hour */ && Math.abs(ago) < DAY) {
          const spelled = t.remind_at ?? `${t.due_date}T${t.time}`;
          const wasShown = shown.some((s) => s.kind === "remind" && s.task.id === t.id && (s.notice.key.endsWith(`:${moment.text}`) || s.notice.key.endsWith(`:${spelled}`)));
          expect(wasShown, fail(`G4 ${t.id} was due at ${moment.text} (${ago / MIN} min ago, ${settings.zone}) and was never shown`)).toBe(true);
        }
      }
    }
  };

  const advanceTo = (ms: number) => { now = ms; vi.setSystemTime(now); };
  // opening the app: the hook reads the persisted set and fetches at once
  const openApp = () => { fired = new Set(JSON.parse(persisted)); held = null; tick(); verify(true); };
  openApp();

  for (const op of w.ops) {
    trace.push(`${JSON.stringify(op)} @ ${where()}`);
    if (op.k === "run") {
      const step = op.hidden ? MIN : 15_000;
      for (let t = step; t <= op.minutes * MIN; t += step) {
        advanceTo(now + step);
        const poll = (t % (5 * MIN)) === 0;
        if (poll) tick(); else remind();
        verify(poll);
      }
    } else if (op.k === "sleep") { advanceTo(now + op.hours * HOUR); tick(); verify(true); }
    else if (op.k === "reload") openApp();
    else if (op.k === "show") { tick(); verify(true); }
    else if (op.k === "clock") { settings = { zone: op.zone ?? settings.zone, dayStart: op.dayStart ?? settings.dayStart }; }
    else {
      const t = tasks[op.task % tasks.length]!;
      if (op.k === "finish") t.status = "done";
      else if (op.k === "reopen") { if (t.status === "done" || t.status === "cancelled") t.status = "todo"; }
      else if (op.what === "due" || op.what === "time") {
        // The server's rule for a moved task (updateTask): a wall-clock reminder goes with it, an instant stays.
        const before = { when: t.due_date, time: t.time };
        if (op.what === "due") t.due_date = addDay(todayAt(now, settings), op.by);
        else t.time = op.by < 0 ? null : ["02:00", "09:00", "23:00", "04:00"][op.by]!;
        t.remind_at = reminderAfterMove(t.remind_at, before, { when: t.due_date, time: t.time }, settings.dayStart);
      }
      else { const wall = `${addDay(todayAt(now, settings), op.by)}T${pad((new Date(now).getUTCHours() + 1) % 24)}:30`; t.remind_at = wall; }
    }
  }
}

// A known failure is asserted with at least `floor` runs: a short run that misses it would turn red by itself.
const run = (checks: Checks, floor = 0) => fc.assert(fc.property(worldArb, (w) => play(build(w), checks)), { numRuns: Math.max(PROPS_RUNS, floor), seed: PROPS_SEED });
const NONE = { green: false, once: false, startTime: false, live: false };

describe("in-app reminders over a random life of an agenda", () => {
  it("G1: a due notice once per entry, a finished task never shown, the fired set bounded, no reminder at a clock time before it", () => {
    run({ ...NONE, green: true });
  }, 600_000);

  // Fixed (G1, found by PROPS_RUNS=400): a reminder fired, then the task was finished. The hook's remind()
  // returned early when it had nothing to show, so the key of the finished task's reminder stayed in the
  // persisted set for good (the set grew with every reminded task). Named case below.
  it("G1 named case: the fired key of a reminder is dropped once its task is finished", () => {
    play(build({
      start: Date.UTC(2026, 2, 8, 0, 0, 0), settings: { zone: "Europe/Berlin", dayStart: 0 }, closedInAgenda: false,
      tasks: [{ id: "t0", status: "todo", dueOffset: 0, time: null, remind: { kind: "wall", dayOffset: 0, time: "01:00", shiftMin: 0 } }],
      ops: [{ k: "finish", task: 0 }, { k: "sleep", hours: 1 }],
    }), { ...NONE, green: true });
  });

  // History (G2). pendingDueNotices (dueSoonNotify.ts) keeps only the keys of due/overdue notices and drops every
  // `remind:` key. The hook runs it before pendingRemindNotices on every 5-minute poll, so the reminder's key is
  // forgotten there and the next 15-second check shows the same moment again, every poll for 12 hours.
  // Fixed (scan 10 #6): reminderMoment takes the day-start hour.
  describe("G2 each (task, reminder moment) is shown once", () => {
    it("random agendas", () => { run({ ...NONE, once: true }, 3000); }, 600_000);
    it("named case: a reminder at 09:00 is shown again at the next 5-minute poll", () => {
      play(build({
        start: Date.UTC(2026, 5, 10, 8, 59, 0), settings: { zone: "UTC", dayStart: 0 }, closedInAgenda: false,
        tasks: [{ id: "t0", status: "todo", dueOffset: 0, time: null, remind: { kind: "wall", dayOffset: 0, time: "09:00", shiftMin: 0 } }],
        ops: [{ k: "run", minutes: 8, hidden: false }],
      }), { ...NONE, once: true });
    });
  });

  // History (G3). "Task on day D at 02:00, the day starting at 04:00" means D+1 02:00 on the wall clock, but
  // reminderMoment (@onden/markdown taskReminder.ts) spells it D T02:00. The reminder is shown 12–24 h early
  // (from 04:00 on D, when the task becomes today's), and a push says it at D 02:00, a day early.
  // Fixed (scan 10 #6): reminderMoment takes the day-start hour.
  describe("G3 a start-time reminder is not shown before the task's time on the workspace's day", () => {
    it("random agendas", () => { run({ ...NONE, startTime: true }, 3000); }, 600_000);
    it("named case: 02:00 on a day that starts at 04:00 is shown at 05:00 the day before it", () => {
      play(build({
        start: Date.UTC(2026, 5, 10, 4, 58, 0), settings: { zone: "UTC", dayStart: 4 }, closedInAgenda: false,
        tasks: [{ id: "t0", status: "todo", dueOffset: 0, time: "02:00", remind: null }],
        ops: [{ k: "run", minutes: 3, hidden: false }],
      }), { ...NONE, startTime: true });
    });
  });

  // History (G4). A reminder is judged only for tasks in the overdue / today buckets (dueTasks): a task due next
  // week, with no date, or whose start time falls in the hours before the day starts is bucketed elsewhere when
  // its moment comes, so the open app never says it, while the server's push (any open task) does.
  // Fixed (scan 10 #8): pendingRemindNotices reads every bucket of the agenda.
  describe("G4 a reminder whose moment has come is shown by the next check", () => {
    it("random agendas", () => { run({ ...NONE, live: true }, 3000); }, 600_000);
    it("named case: 'remind me at 15:00' on a task due next week is never shown by the open app", () => {
      play(build({
        start: Date.UTC(2026, 5, 10, 14, 50, 0), settings: { zone: "UTC", dayStart: 0 }, closedInAgenda: false,
        tasks: [{ id: "t0", status: "todo", dueOffset: 5, time: null, remind: { kind: "wall", dayOffset: 0, time: "09:00", shiftMin: 0 } }],
        ops: [{ k: "run", minutes: 12, hidden: false }],
      }), { ...NONE, live: true });
    });
  });

  // A wall-clock reminder is judged against the workspace's own wall clock (reminderMoment / dueReminderMoment, the one rule
  // the app and the push both use), so a daylight-saving change decides nothing by itself.
  describe("DST: a wall-clock reminder in a zone's clock change", () => {
    const task = { status: "todo", remind_at: "2026-03-08T02:30" };
    const wallAt = (at: number, zone: string) => nowDateTimeId(new Date(at), zone).slice(0, 16);
    const zone = "America/New_York";
    it("spring forward: 02:30 does not exist that night, so the reminder is due when the clock first reads 03:00 and no earlier", () => {
      const before = Date.UTC(2026, 2, 8, 6, 59); // 01:59 EST
      const after = Date.UTC(2026, 2, 8, 7, 0); // 03:00 EDT: 02:30 was skipped
      expect(wallAt(before, zone)).toBe("2026-03-08T01:59");
      expect(wallAt(after, zone)).toBe("2026-03-08T03:00");
      expect(dueReminderMoment(task, { ms: before, wall: wallAt(before, zone) })).toBeNull();
      expect(dueReminderMoment(task, { ms: after, wall: wallAt(after, zone) })?.text).toBe("2026-03-08T02:30");
    });
    it("fall back: 01:30 happens twice, the reminder is one moment (one key) both times, due from the first", () => {
      const first = Date.UTC(2026, 10, 1, 5, 30); // 01:30 EDT
      const second = Date.UTC(2026, 10, 1, 6, 30); // 01:30 EST
      const t = { status: "todo", remind_at: "2026-11-01T01:30" };
      expect(wallAt(first, zone)).toBe("2026-11-01T01:30");
      expect(wallAt(second, zone)).toBe("2026-11-01T01:30");
      const a = dueReminderMoment(t, { ms: first, wall: wallAt(first, zone) });
      const b = dueReminderMoment(t, { ms: second, wall: wallAt(second, zone) });
      expect(a).not.toBeNull();
      expect(reminderKey("x", a!)).toBe(reminderKey("x", b!)); // the fired set holds it: shown once
      expect(dueReminderMoment(t, { ms: first - 60_000, wall: wallAt(first - 60_000, zone) })).toBeNull();
    });
  });
});
