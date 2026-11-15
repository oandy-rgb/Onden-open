// External calendars (migration 160): personal, address kept encrypted, read-only.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import router from "../modules/external_calendars/routes.js";
import { __setCalendarFetchForTests } from "../modules/external_calendars/refresh.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(DB) || /onden_test(\?|$)/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/external-calendars", router);

const SECRET_URL = "https://calendar.example.com/private/TOKEN-9f8e7d6c/basic.ics";
const ics = (when: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:${when}\r\nDTEND:${when.replace("T09", "T10")}\r\nSUMMARY:Planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
// A day a week from now, inside the window a fetch keeps (refresh.ts RANGE_PAST_DAYS / RANGE_FUTURE_DAYS).
const DAY = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
const goodFetch = async () => ({ status: 200, text: ics(`${DAY.replaceAll("-", "")}T090000Z`) });
const send = (method: string, path: string, body?: unknown) => app.request(`/api/external-calendars${path}`, {
  method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

describe.skipIf(!isTestDb)("external calendars", () => {
  let alice: ActorCtx; let bob: ActorCtx; let WS = "";
  const savedKey = process.env.ONDEN_SECRET_KEY;
  const stamp = Date.now();

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    alice = await persistActor(WS, { id: `ec-alice-${stamp}`, name: "Alice", role: "editor", type: "human" });
    bob = await persistActor(WS, { id: `ec-bob-${stamp}`, name: "Bob", role: "viewer", type: "human" });
    process.env.ONDEN_SECRET_KEY = randomBytes(32).toString("hex");
  });
  // Each test starts with no calendars and a calendar server that answers: the suite runs in a shuffled order.
  beforeEach(async () => {
    await seedQ(`DELETE FROM external_calendars WHERE actor_id = ANY($1::uuid[])`, [[alice.id, bob.id]]);
    __setCalendarFetchForTests(goodFetch);
  });
  /** Alice subscribes to a calendar (fetched once on the way in). */
  const addCalendar = async (name = "Work", color = "#3b82f6", url = SECRET_URL) => {
    currentActor = alice;
    const res = await send("POST", "", { name, color, url });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };
  afterAll(() => {
    __setCalendarFetchForTests(null);
    if (savedKey === undefined) delete process.env.ONDEN_SECRET_KEY; else process.env.ONDEN_SECRET_KEY = savedKey;
  });

  it("keeps the address only as ciphertext and never answers it back", async () => {
    currentActor = alice;
    const res = await send("POST", "", { name: "Work", color: "#3b82f6", url: SECRET_URL });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("TOKEN-9f8e7d6c");
    const made = JSON.parse(text) as { id: string; host: string; last_error: string | null; last_fetched_at: string | null };
    expect(made.host).toBe("calendar.example.com");
    expect(made.last_error).toBeNull();
    expect(made.last_fetched_at).not.toBeNull();
    const list = await (await send("GET", "")).text();
    expect(list).not.toContain("TOKEN-9f8e7d6c");
    const row = (await q<{ url_ciphertext: Buffer }>(`SELECT url_ciphertext FROM external_calendars WHERE id = $1`, [made.id])).rows[0]!;
    expect(row.url_ciphertext.toString("utf8")).not.toContain("TOKEN-9f8e7d6c");
    expect(row.url_ciphertext.toString("latin1")).not.toContain("calendar.example.com");
    // Nothing about it reached the event log.
    const logged = await q(`SELECT 1 FROM domain_events WHERE payload::text LIKE '%TOKEN-9f8e7d6c%' OR payload::text LIKE '%calendar.example.com%' LIMIT 1`);
    expect(logged.rows).toHaveLength(0);
  });

  it("is personal: another person sees nothing and cannot change or refresh it", async () => {
    const cal = await addCalendar();
    currentActor = bob;
    expect(((await (await send("GET", "")).json()) as { calendars: unknown[] }).calendars).toHaveLength(0);
    expect((await send("PATCH", `/${cal!.id}`, { name: "x" })).status).toBe(404);
    expect((await send("DELETE", `/${cal!.id}`)).status).toBe(404);
    expect((await send("POST", `/${cal!.id}/refresh`)).status).toBe(404);
    const events = (await (await send("GET", `/events?from=${DAY}&to=${DAY}`)).json()) as { events: unknown[] };
    expect(events.events).toHaveLength(0);
  });

  it("lists events on the workspace day and drops them when the calendar is switched off", async () => {
    const cal = await addCalendar();
    const read = async () => ((await (await send("GET", `/events?from=${DAY}&to=${DAY}`)).json()) as { events: Array<{ title: string; start_day: string; color: string }> }).events;
    const got = await read();
    expect(got.map((e) => e.title)).toEqual(["Planning"]);
    expect(got[0]!.color).toBe("#3b82f6");
    await send("PATCH", `/${cal!.id}`, { enabled: false });
    expect(await read()).toHaveLength(0);
  });

  it("refuses a second manual refresh within a minute", async () => {
    const cal = await addCalendar();
    await seedQ(`UPDATE external_calendars SET last_attempt_at = now() WHERE id = $1`, [cal!.id]);
    expect((await send("POST", `/${cal!.id}/refresh`)).status).toBe(429);
  });

  it("notes a calendar that cannot be opened and keeps the last events", async () => {
    const made = await addCalendar("Other", "#22c55e", "https://other.example.com/a.ics");
    await seedQ(`UPDATE external_calendars SET last_attempt_at = now() - interval '5 minutes' WHERE id = $1`, [made.id]);
    __setCalendarFetchForTests(async () => ({ status: 200, text: "<html>not a calendar</html>" }));
    const after = (await (await send("POST", `/${made.id}/refresh`)).json()) as { last_error: string };
    expect(after.last_error).toBe("not_calendar");
    const events = (await q(`SELECT 1 FROM external_calendar_events WHERE calendar_id = $1`, [made.id])).rows;
    expect(events.length).toBeGreaterThan(0);
  });

  it("refuses to keep an address without ONDEN_SECRET_KEY, and says so", async () => {
    currentActor = alice;
    const key = process.env.ONDEN_SECRET_KEY;
    delete process.env.ONDEN_SECRET_KEY;
    try {
      expect(((await (await send("GET", "")).json()) as { available: boolean }).available).toBe(false);
      const res = await send("POST", "", { name: "Nope", color: "#22c55e", url: "https://x.example.com/a.ics" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("no secret key");
    } finally { process.env.ONDEN_SECRET_KEY = key; }
  });

  it("refuses an address that is not http(s), and an agent token", async () => {
    currentActor = alice;
    const res = await send("POST", "", { name: "Bad", color: "#22c55e", url: "file:///etc/passwd" });
    expect(res.status).toBe(422);
    currentActor = { ...alice, tokenScope: { tokenId: "t", allowedTools: null, access: "write", expiresAt: null, writeMode: "apply", issuedBy: null, sessionId: null } };
    expect((await send("GET", "")).status).toBe(403);
  });

  it("deleting a calendar deletes its events", async () => {
    await addCalendar();
    await addCalendar("Other", "#22c55e", "https://other.example.com/a.ics");
    expect((await q(`SELECT 1 FROM external_calendar_events e JOIN external_calendars c ON c.id = e.calendar_id WHERE c.actor_id = $1`, [alice.id])).rows.length).toBeGreaterThan(0);
    const list = ((await (await send("GET", "")).json()) as { calendars: Array<{ id: string }> }).calendars;
    for (const c of list) expect((await send("DELETE", `/${c.id}`)).status).toBe(200);
    expect((await q(`SELECT 1 FROM external_calendar_events e JOIN external_calendars c ON c.id = e.calendar_id WHERE c.actor_id = $1`, [alice.id])).rows).toHaveLength(0);
  });
});
