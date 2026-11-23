// A temporary session reads the personal data of the person who opened it, and never writes it (docs/architecture/proposals/sessions-reads-own-2026-11-17.md).
//
// The personal data is read at seven kinds of place (preferences, review settings, review progress, focus records, RSS seen, RSS mutes, external calendars:
// every one of them asks spine/authority.ts personalDataOwnerId whose rows to read). For a random person P with random personal rows, a session P opened
// must read exactly what P reads, MINUS what a session has no use for and so is not given (the model `forASession` below, written here, not taken from the code):
//   - the preferences that hold ids of notes, tags, feeds and articles               (read as never set)
//   - the focus records on a task outside the session's spaces                       (left out)
//   - the keyword mutes of the reader                                                (left out; the feed mutes of feeds it can read stay)
//   - a calendar's address host and its last fetch error                             (blank)
// and a session opened by SOMEONE ELSE reads their rows and none of P's. Neither side's text appears in the other's answers.
//
// The "someone else" session is a session of the owner's whose `opened_by` is then set to the member (only the owner opens sessions today): the rule under
// test is that the answer follows `opened_by`, whoever it names.
//
// SAFETY: only runs against a *_test database; skips otherwise. Run count: PROPS_RUNS (capped at 8: a run seeds dozens of rows), seed PROPS_SEED.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool, q } from "../../db.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { checkAsync } from "../helpers/propsConfig.js";
import { newNote, openAs, standardWorld } from "../helpers/sessionWorld.js";
import { seedQ } from "../helpers/seedQ.js";
import { seedClassTag } from "../helpers/seedClassTag.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { turnModuleOn } from "../helpers/setModulesOn.js";
import { resolveTemporarySessionActor } from "../../services/participantSessions.js";
import { PREF_KEYS, readPref, type PrefKey } from "../../services/actorPrefs.js";
import { addCalendar, eventsBetween, getCalendar, listCalendars } from "../../modules/external_calendars/store.js";
import { listMutes } from "../../modules/rss/mutes.js";
import { listStagedItems } from "../../modules/rss/itemList.js";
import { subscriptionList } from "../../modules/rss/subscriptions.js";
import { focusOfDay } from "../../modules/tasks/focus.js";
import { cardState, grade, personalSettings, replaceSettings } from "../../modules/review/service.js";
import { localDayId } from "../../localDay.js";

/** A fixed instant (noon UTC of a past day) and its day in the workspace's time, for what is read "by day" (focus records, calendar events):
 *  seeded there and read by that day, so the clock does not matter (a run near midnight once missed a record). */
const FIXED_AT = new Date("2026-01-15T12:00:00Z");
const FIXED_DAY = localDayId(FIXED_AT);
import type { ActorCtx } from "../../types.js";

registerShippedModules();
process.env.ONDEN_SECRET_KEY ??= "ab".repeat(32);

let ownWorkspace = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
let signedInAs: string | null = null;
vi.mock("../../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => signedInAs ? { user: { id: signedInAs, name: "Person", email: `${signedInAs}@reads-own.test` } } : null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
  configuredSocialProviders: [],
}));
const { app } = await import("../../app.js");

type World = Awaited<ReturnType<typeof standardWorld>>;
let w: World;
let noteA = "", noteB = "", reviewTag = "", sourceA = "", sourceB = "";
let sessionOfP: ActorCtx, sessionOfM: ActorCtx, credentialOfP = "";

/** The preferences a session is NOT given (model; the code's own table is services/actorPrefs.ts SESSION_MAY_READ_PREF). */
const HIDDEN_PREFS: ReadonlySet<PrefKey> = new Set<PrefKey>(["sidebarTags", "recentBlocks", "dayNoteParent", "captureDestination", "rssFeedCounts", "rssReadingPosition", "reviewScope", "splitPane", "splitPane.phone", "splitPane.desktop"]);

type Read = Awaited<ReturnType<typeof readEverything>>;
/** Every personal read there is, as one actor sees it. */
async function readEverything(actor: ActorCtx) {
  return {
    prefs: Object.fromEntries(await Promise.all(PREF_KEYS.map(async (key) => [key, await readPref(actor, key)] as const))),
    reviewState: await cardState(actor, noteA),
    reviewSettings: await personalSettings(actor, reviewTag),
    calendars: await listCalendars(actor),
    events: await eventsBetween(actor, FIXED_DAY, FIXED_DAY),
    mutes: await listMutes(actor, ownWorkspace),
    items: await listStagedItems(actor, ownWorkspace, { limit: 200 }),
    unseen: (await subscriptionList(actor, ownWorkspace)).sources.map((s) => ({ title: s.title, unseen: s.unseen })).sort((a, b) => a.title.localeCompare(b.title)),
    focus: await focusOfDay(actor, { day: FIXED_DAY }),
  };
}

/** What a session is given of what its person reads (the rules of the proposal, written out here). */
function forASession(own: Read): Read {
  // a record on a task of B is left out; a record on no task keeps its time and loses its sentence
  const shown = <T extends { note: string }>(s: T): T => ((s.note ?? "").endsWith("@none") ? { ...s, note: "" } : s);
  const sessions = (own.focus.sessions).filter((s) => !(s.note ?? "").endsWith("@B")).map(shown);
  const running = own.focus.running && !(own.focus.running.note ?? "").endsWith("@B") ? shown(own.focus.running) : null;
  return {
    ...own,
    prefs: Object.fromEntries(Object.entries(own.prefs).map(([key, value]) => [key, HIDDEN_PREFS.has(key as PrefKey) ? null : value])),
    calendars: own.calendars.map((c) => ({ ...c, host: "", last_error: null })),
    events: own.events.map((e) => ({ ...e, title: "忙碌", location: "", description: "" })), // the time and that the person is busy, nothing else
    items: "rows" in own.items ? { ...own.items, rows: own.items.rows.filter((r) => r.title.endsWith("@A")) } : own.items,
    unseen: own.unseen.filter((u) => u.title.endsWith("@A")), // the feeds of a space the session is not in
    mutes: own.mutes.filter((m) => m.source_id !== null && m.source_title !== null && m.source_title.endsWith("@A")),
    focus: { ...own.focus, sessions, running },
  };
}

type Plan = {
  prefs: boolean[]; // by PREF_KEYS index: is the key set
  calendars: number; // 0..2
  keywordMutes: number; feedMuteA: boolean; feedMuteB: boolean;
  items: Array<{ in: "A" | "B"; seen: boolean | null }>;
  focus: Array<{ task: "A" | "B" | "none"; running: boolean }>;
};
const planArb: fc.Arbitrary<Plan> = fc.record({
  prefs: fc.array(fc.boolean(), { minLength: PREF_KEYS.length, maxLength: PREF_KEYS.length }),
  calendars: fc.integer({ min: 0, max: 2 }),
  keywordMutes: fc.integer({ min: 0, max: 2 }), feedMuteA: fc.boolean(), feedMuteB: fc.boolean(),
  items: fc.array(fc.record({ in: fc.constantFrom("A" as const, "B" as const), seen: fc.constantFrom(true, false, null) }), { maxLength: 5 }),
  focus: fc.array(fc.record({ task: fc.constantFrom("A" as const, "B" as const, "none" as const), running: fc.boolean() }), { maxLength: 3 }),
});

/** Seed one person's personal rows for a plan; every text carries `tag` ("ownerP-…" or "memberM-…") so a row can be told apart in an answer (the articles are the FEED's, shared by everyone who reads it: only whether each is seen is the person's). */
async function seedPerson(person: { id: string; ctx: ActorCtx }, tag: string, plan: Plan): Promise<void> {
  const ws = ownWorkspace;
  for (const [i, key] of PREF_KEYS.entries()) {
    if (plan.prefs[i]) await seedQ(`INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, $2, $3::jsonb)`, [person.id, key, JSON.stringify({ mark: `${tag}-pref-${key}` })]);
  }
  for (let i = 0; i < plan.calendars; i++) {
    const id = randomUUID();
    await addCalendar(ws, person.ctx, { id, name: `${tag}-cal-${i}`, color: "#336699", href: `https://calendar.test/${tag}-secret-${i}.ics`, host: `${tag}-host-${i}.test` });
    await seedQ(`UPDATE external_calendars SET last_error = 'unreachable' WHERE id = $1`, [id]); // (a closed set of codes: migration 160)
    await seedQ(`INSERT INTO external_calendar_events (calendar_id, instance_key, title, all_day, starts_at, ends_at) VALUES ($1, $2, $3, false, ($4::date + time '10:00') AT TIME ZONE 'UTC', ($4::date + time '11:00') AT TIME ZONE 'UTC')`,
      [id, `${tag}-ev-${i}`, `${tag}-event-${i}`, FIXED_DAY]);
  }
  for (let i = 0; i < plan.keywordMutes; i++) {
    await seedQ(`INSERT INTO rss_mutes (workspace_id, actor_id, keyword, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`, [ws, person.id, `${tag}-keyword-${i}`]);
  }
  for (const [on, source] of [[plan.feedMuteA, sourceA], [plan.feedMuteB, sourceB]] as const) {
    if (on) await seedQ(`INSERT INTO rss_mutes (workspace_id, actor_id, subscription_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`, [ws, person.id, source]);
  }
  for (const [i, item] of plan.items.entries()) {
    const id = (await seedQ<{ id: string }>(`INSERT INTO rss_staging (workspace_id, subscription_id, guid, title) VALUES ($1, $2, $3, $4) RETURNING id::text`,
      [ws, item.in === "A" ? sourceA : sourceB, `guid-${tag.split("-")[1]}-${tag.startsWith("owner") ? "p" : "m"}-${i}`, `item-${tag.split("-")[1]}-${tag.startsWith("owner") ? "p" : "m"}-${i}@${item.in}`])).rows[0]!.id;
    if (item.seen !== null) await seedQ(`INSERT INTO rss_seen (staging_id, actor_id, seen) VALUES ($1, $2, $3)`, [id, person.id, item.seen]);
  }
  for (const [i, f] of plan.focus.entries()) {
    const task = f.task === "A" ? noteA : f.task === "B" ? noteB : null;
    if (f.running && i > 0) continue; // one running record per person
    // at a fixed instant, minutes apart, read back by that instant's day (FIXED_DAY): records started "an hour before now" fell on yesterday for a
    // run between midnight and 03:00 UTC (the control below then missed one)
    const started = new Date(FIXED_AT.getTime() - (i + 1) * 60_000);
    await seedQ(`INSERT INTO focus_sessions (id, workspace_id, actor_id, task_id, started_at, ended_at, note) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), ws, person.id, task, started, f.running ? null : new Date(FIXED_AT.getTime() + 30 * 60_000 - i * 60_000), `${tag}-focus-${i}@${f.task}`]);
  }
}

async function clearPerson(id: string): Promise<void> {
  await seedQ(`DELETE FROM actor_prefs WHERE actor_id = $1`, [id]);
  await seedQ(`DELETE FROM external_calendars WHERE actor_id = $1`, [id]);
  await seedQ(`DELETE FROM rss_mutes WHERE actor_id = $1`, [id]);
  await seedQ(`DELETE FROM rss_seen WHERE actor_id = $1`, [id]);
  await seedQ(`DELETE FROM focus_sessions WHERE actor_id = $1`, [id]);
}
async function clearItems(): Promise<void> { await seedQ(`DELETE FROM rss_staging WHERE workspace_id = $1`, [ownWorkspace]); }

type Init = { method?: string; body?: unknown };
async function callAsSession(path: string, init: Init = {}) {
  const res = await app.request(path, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${credentialOfP}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

describe.skipIf(!isTestDatabase())("a session reads the personal data of the person who opened it (and only theirs), and writes none", () => {
  beforeAll(async () => {
    w = await standardWorld("reads-own");
    ownWorkspace = w.ws;
    for (const id of ["review", "rss", "external_calendars", "tasks"]) await turnModuleOn(w.ws, id);
    noteA = await newNote(w.ws, "note in A", w.spaceA, "body A");
    noteB = await newNote(w.ws, "note in B", w.spaceB, "body B");
    // review: a tag that holds the limits, applied to a note of A that is a card; the owner and the member each graded it and each set their own limits
    reviewTag = (await seedClassTag(w.ws, { name: `reviewtag-${randomUUID().slice(0, 6)}` })).tagId;
    await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || '{"module":"review"}'::jsonb WHERE id = $1`, [reviewTag]);
    await seedQ(`INSERT INTO node_tags(node_id, tag_id) VALUES($1,$2)`, [noteA, reviewTag]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'review', $2) ON CONFLICT DO NOTHING`, [w.ws, noteA]);
    await grade(w.owner.ctx, noteA, 3);
    await grade(w.member.ctx, noteA, 1);
    await replaceSettings(w.owner.ctx, reviewTag, { maximum_interval_days: 7 });
    await replaceSettings(w.member.ctx, reviewTag, { maximum_interval_days: 9 });
    // rss: one feed in each space
    for (const [space, label] of [[w.spaceA, "A"], [w.spaceB, "B"]] as const) {
      const id = (await seedQ<{ id: string }>(`INSERT INTO rss_subscriptions (workspace_id, space_id, title, url) VALUES ($1, $2, $3, $4) RETURNING id::text`,
        [w.ws, space, `feed@${label}`, `https://feed.test/${randomUUID()}.xml`])).rows[0]!.id;
      if (label === "A") sourceA = id; else sourceB = id;
    }
    // the owner's session on A, and one of the owner's sessions that says the MEMBER opened it
    const opened = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "view" }] });
    credentialOfP = opened.credential;
    sessionOfP = (await resolveTemporarySessionActor(opened.credential, w.ws))!;
    const other = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "view" }] });
    await seedQ(`UPDATE participant_sessions SET opened_by = $2 WHERE id = $1`, [other.sessionId, w.member.id]);
    sessionOfM = (await resolveTemporarySessionActor(other.credential, w.ws))!;
  }, 120_000);
  afterAll(async () => { await pool.end(); });

  it("the session of P reads what P reads minus what it is not given; a session opened by someone else reads that person's rows and none of P's", async () => {
    expect(sessionOfP.sessionScope?.openedBy).toBe(w.owner.id);
    expect(sessionOfM.sessionScope?.openedBy).toBe(w.member.id);
    await checkAsync(fc.asyncProperty(planArb, planArb, async (planP, planM) => {
      const run = randomUUID().slice(0, 6);
      const tagP = `ownerP-${run}`, tagM = `memberM-${run}`;
      try {
        await seedPerson(w.owner, tagP, planP);
        await seedPerson(w.member, tagM, planM);
        const ownP = await readEverything(w.owner.ctx), ownM = await readEverything(w.member.ctx);
        const bySessionP = await readEverything(sessionOfP), bySessionM = await readEverything(sessionOfM);
        // the seeding worked: what a person with data reads of their own is not empty (else "M's session reads none of P's" would hold for any empty M)
        for (const [plan, own, tag] of [[planP, ownP, tagP], [planM, ownM, tagM]] as const) {
          const hasData = plan.prefs.some(Boolean) || plan.calendars > 0 || plan.keywordMutes > 0 || plan.feedMuteA || plan.feedMuteB || plan.items.length > 0 || plan.focus.length > 0;
          if (hasData) expect(JSON.stringify(own), `${tag} wrote rows and reads them back`).toMatch(tag.startsWith("owner") ? /ownerP-|item-/ : /memberM-|item-/);
        }
        expect(bySessionP).toEqual(forASession(ownP));
        expect(bySessionM).toEqual(forASession(ownM));
        // nothing of the other person, in either direction, in any answer
        expect(JSON.stringify(bySessionM)).not.toContain("ownerP-");
        expect(JSON.stringify(bySessionP)).not.toContain("memberM-");
        // and what was held back is not in the answer at all (the model above must not just agree with itself)
        const text = JSON.stringify(bySessionP);
        for (const hidden of [`${tagP}-keyword-`, `${tagP}-host-`, `${tagP}-event-`, `unreachable`, `${tagP}-secret`, `${tagP}-pref-sidebarTags`, `${tagP}-pref-dayNoteParent`, `${tagP}-pref-splitPane`, `@B`]) {
          expect([hidden, text.includes(hidden)]).toEqual([hidden, false]);
        }
      } finally {
        await clearPerson(w.owner.id); await clearPerson(w.member.id); await clearItems();
      }
    }), 8);
  }, 300_000);

  it("controls: the answers are not empty for a person with data (the property above would pass on two empty answers)", async () => {
    const tagP = `ownerP-${randomUUID().slice(0, 6)}`;
    try {
      await seedPerson(w.owner, tagP, {
        prefs: PREF_KEYS.map(() => true), calendars: 1, keywordMutes: 1, feedMuteA: false, feedMuteB: true,
        items: [{ in: "A", seen: true }, { in: "A", seen: null }, { in: "B", seen: false }], focus: [{ task: "A", running: false }, { task: "B", running: false }, { task: "none", running: false }],
      });
      const read = await readEverything(sessionOfP);
      expect(read.prefs.nav).toEqual({ mark: `${tagP}-pref-nav` });
      expect(read.prefs.dayNoteParent).toBeNull();
      expect(read.calendars.map((c) => c.name)).toEqual([`${tagP}-cal-0`]);
      expect(read.calendars[0]).toMatchObject({ host: "", last_error: null });
      expect(read.events.map((e) => [e.title, e.location, e.description])).toEqual([["忙碌", "", ""]]); // busy, with the time (starts_at / ends_at stay)
      expect(read.events[0]!.starts_at).toBeTruthy();
      expect(read.mutes).toEqual([]); // the keyword mute is not listed, the mute of feed B (a feed it cannot read) neither
      expect("rows" in read.items ? read.items.rows.map((r) => `${r.title}:${r.seen}`).sort() : null).toEqual([`item-${tagP.split("-")[1]}-p-0@A:true`, `item-${tagP.split("-")[1]}-p-1@A:false`]);
      expect(read.unseen).toEqual([{ title: "feed@A", unseen: 1 }]); // the one not seen
      expect(read.focus.sessions.map((s) => s.note).sort()).toEqual(["", `${tagP}-focus-0@A`]); // the record on no task: its time only
      expect(read.reviewState.state).not.toBeNull();
      expect(read.reviewSettings).toEqual({ maximum_interval_days: 7 });
    } finally { await clearPerson(w.owner.id); await clearItems(); }
  });

  it("control: a session opened by M reads M's own data, and it is not empty (so \"it reads none of P's\" is not vacuous)", async () => {
    const tagM = `memberM-${randomUUID().slice(0, 6)}`;
    try {
      await seedPerson(w.member, tagM, { prefs: PREF_KEYS.map(() => true), calendars: 1, keywordMutes: 0, feedMuteA: false, feedMuteB: false, items: [], focus: [{ task: "A", running: false }] });
      const read = await readEverything(sessionOfM);
      expect(read.prefs.nav).toEqual({ mark: `${tagM}-pref-nav` });
      expect(read.calendars.map((c) => c.name)).toEqual([`${tagM}-cal-0`]);
      expect(read.focus.sessions.map((s) => s.note)).toEqual([`${tagM}-focus-0@A`]);
      expect(JSON.stringify(read)).not.toContain("ownerP-");
    } finally { await clearPerson(w.member.id); }
  });

  it("review: what the person graded or set in a space the session is not in is not given (settings of a tag only used there, the card's schedule)", async () => {
    const tagB = (await seedClassTag(w.ws, { name: `reviewB-${randomUUID().slice(0, 6)}` })).tagId;
    await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || '{"module":"review"}'::jsonb WHERE id = $1`, [tagB]);
    await seedQ(`INSERT INTO node_tags(node_id, tag_id) VALUES($1,$2)`, [noteB, tagB]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'review', $2) ON CONFLICT DO NOTHING`, [w.ws, noteB]);
    await grade(w.owner.ctx, noteB, 3);
    await replaceSettings(w.owner.ctx, tagB, { maximum_interval_days: 5 });
    // the person reads both; the session reads neither (the tag and the note are not in its space): the same refusal it gets for a thing that does not exist
    expect((await personalSettings(w.owner.ctx, tagB))).toEqual({ maximum_interval_days: 5 });
    await expect(personalSettings(sessionOfP, tagB)).rejects.toMatchObject({ status: 404 });
    await expect(cardState(sessionOfP, noteB)).rejects.toMatchObject({ status: 404 });
    await expect(personalSettings(sessionOfP, randomUUID())).rejects.toMatchObject({ status: 404 });
    // and the card it can read is still given, with the person's own schedule
    expect((await cardState(sessionOfP, noteA)).state).not.toBeNull();
  });

  it("the navigation preference only ever holds the app's own page ids, never a note or a tag id (the screen writes it from the destinations it builds; see the proposal §1)", () => {
    // frontend: hooks/shellNavigation.ts arrangeNavigation builds `candidates` from getNavDestinations (core pages + imported modules); lib/navLayout.ts keeps only ids that are candidates.
    const shell = readFileSync(join(import.meta.dirname, "../../../../frontend/src/hooks/shellNavigation.ts"), "utf8");
    expect(shell).toContain("const candidates = [...core.filter((d) => d.id !== \"notes\"), ...modules];");
    expect(shell).toContain("resolveNavLayout(stored, candidates.map((d) => d.id), unused)");
  });

  it("a mute of a feed of A is listed to the session, and hides that feed's articles from it as it hides them from the person", async () => {
    const tagP = `ownerP-${randomUUID().slice(0, 6)}`;
    try {
      await seedPerson(w.owner, tagP, { prefs: [], calendars: 0, keywordMutes: 0, feedMuteA: true, feedMuteB: false, items: [{ in: "A", seen: null }], focus: [] });
      const own = await readEverything(w.owner.ctx), read = await readEverything(sessionOfP);
      expect(read.mutes.map((m) => m.source_title)).toEqual(["feed@A"]);
      expect("rows" in read.items ? read.items.rows : null).toEqual([]);
      expect("rows" in own.items ? own.items.rows : null).toEqual([]);
    } finally { await clearPerson(w.owner.id); await clearItems(); }
  });

  describe("it never writes the person's data back (every write is refused, nothing changes)", () => {
    const writes: Array<[string, string, string, unknown]> = [
      ["a preference", "PUT", "/api/me/prefs/nav", { value: { order: ["notes"], phone: 1 } }],
      ["a calendar added", "POST", "/api/external-calendars", { name: "x", color: "#336699", url: "https://calendar.test/x.ics" }],
      ["a keyword mute", "POST", "/api/rss/mutes", { keyword: "nope" }],
      ["a focus record", "POST", "/api/tasks/focus", {}],
    ];
    it.each(writes)("%s", async (_label, method, path, body) => {
      const before = await q<{ n: number }>(`SELECT (SELECT count(*) FROM actor_prefs WHERE actor_id::text = $1::text) + (SELECT count(*) FROM external_calendars WHERE actor_id::text = $1::text)
        + (SELECT count(*) FROM rss_mutes WHERE actor_id::text = $1::text) + (SELECT count(*) FROM focus_sessions WHERE actor_id::text = $1::text) AS n`, [w.owner.id]);
      const res = await callAsSession(path, { method, body });
      expect(res.status, res.text).toBe(403);
      const after = await q<{ n: number }>(`SELECT (SELECT count(*) FROM actor_prefs WHERE actor_id::text = $1::text) + (SELECT count(*) FROM external_calendars WHERE actor_id::text = $1::text)
        + (SELECT count(*) FROM rss_mutes WHERE actor_id::text = $1::text) + (SELECT count(*) FROM focus_sessions WHERE actor_id::text = $1::text) AS n`, [w.owner.id]);
      expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n));
    });
    it("grading a card, setting the review limits, marking an article seen, ending a mute", async () => {
      const item = (await seedQ<{ id: string }>(`INSERT INTO rss_staging (workspace_id, subscription_id, guid, title) VALUES ($1, $2, 'seen-probe', 'x') RETURNING id::text`, [w.ws, sourceA])).rows[0]!.id;
      const stateBefore = (await q(`SELECT state FROM review_states WHERE node_id = $1 AND actor_id = $2`, [noteA, w.owner.id])).rows[0];
      for (const [method, path, body] of [
        ["POST", `/api/review/${noteA}/grade`, { rating: 1 }],
        ["PUT", `/api/review/settings/${reviewTag}`, { maximum_interval_days: 1 }],
        ["POST", `/api/rss/items/${item}/seen`, {}],
        ["DELETE", `/api/rss/mutes/${randomUUID()}`, undefined],
      ] as const) {
        const res = await callAsSession(path, { method, body });
        expect([method, path, res.status]).toEqual([method, path, 403]);
      }
      expect((await q(`SELECT state FROM review_states WHERE node_id = $1 AND actor_id = $2`, [noteA, w.owner.id])).rows[0]).toEqual(stateBefore);
      expect(await personalSettings(w.owner.ctx, reviewTag)).toEqual({ maximum_interval_days: 7 });
      expect((await q(`SELECT 1 FROM rss_seen WHERE staging_id = $1`, [item])).rowCount).toBe(0);
      await clearItems();
    });
    it("the calendar routes: a session may read (200) and never change one", async () => {
      const id = randomUUID();
      await addCalendar(w.ws, w.owner.ctx, { id, name: "kept", color: "#336699", href: "https://calendar.test/kept.ics", host: "calendar.test" });
      try {
        const list = await callAsSession("/api/external-calendars");
        expect(list.status).toBe(200);
        expect(JSON.parse(list.text).calendars.map((c: { name: string }) => c.name)).toEqual(["kept"]);
        for (const [method, path] of [["PATCH", `/api/external-calendars/${id}`], ["DELETE", `/api/external-calendars/${id}`], ["POST", `/api/external-calendars/${id}/refresh`]] as const) {
          const res = await callAsSession(path, { method, body: method === "PATCH" ? { name: "renamed" } : undefined });
          expect([method, res.status]).toEqual([method, 403]);
        }
        expect((await getCalendar(w.owner.ctx, id))?.name).toBe("kept");
      } finally { await clearPerson(w.owner.id); }
    });
  });
});
