// A person's own preferences against a real Postgres (services/actorPrefs.ts,
// routes/me.ts, migration 124): the navigation layout 「釘到導覽列」.
//   - GET is null until set; PUT round-trips; null clears;
//   - each person reads and writes only their own row;
//   - an unknown key is 404, a value of the wrong shape 400 (nothing stored);
//   - the rows go with the person.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, q } from "../db.js";
import meRouter from "../routes/me.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/me", meRouter);
const get = (key = "nav") => app.request(`/api/me/prefs/${key}`);
// `deviceNow`: the device's own clock at the moment of sending, as the app's request wrapper adds it (frontend lib/api.ts).
const put = (body: unknown, key = "nav", deviceNow?: number) =>
  app.request(`/api/me/prefs/${key}`, {
    method: "PUT", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(deviceNow === undefined ? {} : { "X-Onden-Client-Now": String(deviceNow) }) },
  });

describe.skipIf(!isTestDb)("a person's own preferences (actor_prefs)", () => {
  let ada: ActorCtx = { id: "a", name: "Ada", role: "editor", type: "human" };
  let bo: ActorCtx = { id: "b", name: "Bo", role: "viewer", type: "human" };
  const created: string[] = [];
  let workspaceId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO NOTHING`);
    const ws = workspaceId = await getWorkspaceId();
    ada = await persistActor(ws, ada);
    bo = await persistActor(ws, bo);
    created.push(ada.id, bo.id);
  });
  beforeEach(async () => {
    await seedQ("DELETE FROM actor_prefs WHERE actor_id = ANY($1::uuid[])", [created]);
    currentActor = ada;
  });
  afterAll(async () => {
    await seedQ("DELETE FROM actor_prefs WHERE actor_id = ANY($1::uuid[])", [created]);
    await q("DELETE FROM space_members WHERE actor_id = ANY($1::uuid[])", [created]);
    // On a workspace with no owner the first human persisted (Ada) became it, and
    // an owner's row can't be deleted: release it, but only if it is ours.
    const { rows } = await q<{ owner_actor_id: string | null }>("SELECT owner_actor_id::text FROM workspaces WHERE id = $1", [workspaceId]);
    if (rows[0]?.owner_actor_id && created.includes(rows[0].owner_actor_id)) await setWorkspaceOwner(workspaceId, null);
    await q("DELETE FROM actors WHERE id = ANY($1::uuid[])", [created]);
  });

  it("is null until set, round-trips, and null clears it", async () => {
    expect(await (await get()).json()).toEqual({ value: null });
    const layout = { order: ["tasks", "reading", "tags"], phone: 3 };
    const res = await put({ value: layout });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: layout, applied: true });
    expect(await (await get()).json()).toEqual({ value: layout });
    // Last write wins.
    await put({ value: { order: ["graph"], phone: 0 } });
    expect(await (await get()).json()).toEqual({ value: { order: ["graph"], phone: 0 } });
    expect((await put({ value: null })).status).toBe(200);
    expect(await (await get()).json()).toEqual({ value: null });
    expect((await q("SELECT 1 FROM actor_prefs WHERE actor_id = $1", [ada.id])).rowCount).toBe(0);
  });

  it("each person has their own", async () => {
    await put({ value: { order: ["tasks"], phone: 1 } });
    currentActor = bo;
    expect(await (await get()).json()).toEqual({ value: null });
    await put({ value: { order: ["graph", "timeline"], phone: 2 } });
    currentActor = ada;
    expect(await (await get()).json()).toEqual({ value: { order: ["tasks"], phone: 1 } });
  });

  it("refuses unknown keys and values of the wrong shape, storing nothing", async () => {
    expect((await get("theme")).status).toBe(404);
    expect((await put({ value: { order: [], phone: 0 } }, "theme")).status).toBe(404);
    for (const value of [
      { order: ["tasks"], phone: 4 },
      { order: ["tasks"], phone: 1.5 },
      { order: "tasks", phone: 1 },
      { order: [""], phone: 0 },
      { order: ["x".repeat(65)], phone: 0 },
      { order: Array.from({ length: 65 }, (_, i) => `d${i}`), phone: 0 },
      { order: ["tasks"], phone: 1, extra: true },
    ]) {
      expect((await put({ value })).status).toBe(400);
    }
    expect((await put({})).status).toBe(400);
    expect((await app.request("/api/me/prefs/nav", { method: "PUT", body: "not json" })).status).toBe(400);
    expect(await (await get()).json()).toEqual({ value: null });
  });

  it("keeps the sidebar's pinned and hidden tags as their own key", async () => {
    const value = { pinned: ["t1", "t2"], hidden: ["t3"] };
    expect(await (await get("sidebarTags")).json()).toEqual({ value: null });
    expect((await put({ value }, "sidebarTags")).status).toBe(200);
    expect(await (await get("sidebarTags")).json()).toEqual({ value });
    // The navigation layout is untouched.
    expect(await (await get()).json()).toEqual({ value: null });
    for (const bad of [{ pinned: ["t1"] }, { pinned: [""], hidden: [] }, { pinned: [], hidden: [], extra: 1 }, { pinned: "t1", hidden: [] }]) {
      expect((await put({ value: bad }, "sidebarTags")).status).toBe(400);
    }
    expect(await (await get("sidebarTags")).json()).toEqual({ value });
  });

  it("keeps the hints already shown as a bounded list of ids", async () => {
    const value = ["welcome", "hashtag-to-scope"];
    expect(await (await get("hintsSeen")).json()).toEqual({ value: null });
    expect((await put({ value }, "hintsSeen")).status).toBe(200);
    expect(await (await get("hintsSeen")).json()).toEqual({ value });
    for (const bad of [{ a: 1 }, "welcome", [""], ["x".repeat(65)], [1], Array.from({ length: 101 }, (_, i) => `h${i}`)]) {
      expect((await put({ value: bad }, "hintsSeen")).status).toBe(400);
    }
    expect(await (await get("hintsSeen")).json()).toEqual({ value });
  });

  it("keeps the day-note parent as a note id, and null clears it", async () => {
    const id = "3f0b7a52-3c1e-4d5a-9a3e-2b8f4c7d1e60";
    expect(await (await get("dayNoteParent")).json()).toEqual({ value: null });
    expect((await put({ value: id }, "dayNoteParent")).status).toBe(200);
    expect(await (await get("dayNoteParent")).json()).toEqual({ value: id });
    // Another person has their own; the other keys are untouched.
    currentActor = bo;
    expect(await (await get("dayNoteParent")).json()).toEqual({ value: null });
    currentActor = ada;
    expect(await (await get()).json()).toEqual({ value: null });
    for (const bad of ["", "x".repeat(65), 7, ["a"], { id }]) {
      expect((await put({ value: bad }, "dayNoteParent")).status).toBe(400);
    }
    expect(await (await get("dayNoteParent")).json()).toEqual({ value: id });
    expect((await put({ value: null }, "dayNoteParent")).status).toBe(200);
    expect(await (await get("dayNoteParent")).json()).toEqual({ value: null });
    expect((await q("SELECT 1 FROM actor_prefs WHERE actor_id = $1", [ada.id])).rowCount).toBe(0);
  });

  it("keeps the RSS and journal preferences as their own keys, and null clears each", async () => {
    const values: Record<string, { good: unknown; bad: unknown[] }> = {
      rssShowCounts: { good: true, bad: ["true", 1, {}] },
      rssFeedCounts: { good: { f1: "on", f2: "off" }, bad: [{ f1: "maybe" }, ["f1"], Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`f${i}`, "on"]))] },
      rssReadingPosition: {
        good: { all: { id: "i1", open: true } },
        bad: [{ all: { id: "i1" } }, Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`v${i}`, { id: "i", open: false }]))],
      },
      rssLastVisit: { good: "2026-10-26T08:00:00.000Z", bad: ["yesterday", "", 5] },
    };
    for (const [key, { good, bad }] of Object.entries(values)) {
      expect(await (await get(key)).json(), key).toEqual({ value: null });
      expect((await put({ value: good }, key)).status, key).toBe(200);
      expect(await (await get(key)).json(), key).toEqual({ value: good });
      for (const value of bad) expect((await put({ value }, key)).status, `${key} ${JSON.stringify(value).slice(0, 40)}`).toBe(400);
      expect(await (await get(key)).json(), key).toEqual({ value: good });
      // Another person has their own.
      currentActor = bo;
      expect(await (await get(key)).json(), key).toEqual({ value: null });
      currentActor = ada;
      expect((await put({ value: null }, key)).status, key).toBe(200);
      expect(await (await get(key)).json(), key).toEqual({ value: null });
    }
    expect((await q("SELECT 1 FROM actor_prefs WHERE actor_id = $1", [ada.id])).rowCount).toBe(0);
  });

  describe("a write that carries the time of the edit (editedAt)", () => {
    const id = "3f0b7a52-3c1e-4d5a-9a3e-2b8f4c7d1e60";
    const id2 = "9a1c2d3e-0000-4000-8000-000000000002";
    const T = 1_790_000_000_000;
    // `sentAt`: the device's clock when the request leaves; the edit's age is that minus `editedAt`, both on the device's clock.
    const putAt = (value: unknown, editedAt: number, key = "dayNoteParent", sentAt = editedAt) => put({ value, editedAt }, key, sentAt);

    it("applies a later edit and refuses an earlier one, answering with what the account holds", async () => {
      expect(await (await putAt(id, T)).json()).toEqual({ value: id, applied: true });
      expect(await (await putAt(id2, T + 1000)).json()).toEqual({ value: id2, applied: true });
      // the phone's offline edit (made before both, 6 s before it is sent) arrives last
      const late = await putAt("older", T - 5000, "dayNoteParent", T + 1000);
      expect(late.status).toBe(200);
      expect(await late.json()).toEqual({ value: id2, applied: false });
      expect(await (await get("dayNoteParent")).json()).toEqual({ value: id2 });
      // the same edit sent again (a lost response) is not an error
      expect(await (await putAt(id2, T + 1000)).json()).toEqual({ value: id2, applied: true });
    });

    it("keeps a reset, so an earlier edit cannot bring the value back", async () => {
      await putAt(id, T);
      expect(await (await putAt(null, T + 1000)).json()).toEqual({ value: null, applied: true });
      expect(await (await get("dayNoteParent")).json()).toEqual({ value: null });
      expect(await (await putAt(id2, T + 500, "dayNoteParent", T + 10_000)).json()).toEqual({ value: null, applied: false });
      expect(await (await get("dayNoteParent")).json()).toEqual({ value: null });
      // a later edit after the reset applies
      expect(await (await putAt(id2, T + 2000)).json()).toEqual({ value: id2, applied: true });
    });

    it("an older frontend (no editedAt) still writes unconditionally, over a stored edit time too", async () => {
      await putAt(id, T);
      expect(await (await put({ value: id2 }, "dayNoteParent")).json()).toEqual({ value: id2, applied: true });
      expect(await (await get("dayNoteParent")).json()).toEqual({ value: id2 });
      expect((await put({ value: null }, "dayNoteParent")).status).toBe(200);
      expect((await q("SELECT 1 FROM actor_prefs WHERE actor_id = $1", [ada.id])).rowCount).toBe(0);
    });

    it("a device whose clock is hours ahead or behind neither wins nor loses because of it", async () => {
      const HOUR = 3_600_000;
      const wait = () => new Promise((r) => setTimeout(r, 15));
      // Ahead by 3 hours: the edit is dated by its age (none), not by that clock, so a real later edit still wins.
      let skewed = Date.now() + 3 * HOUR;
      expect(await (await putAt("ahead", skewed)).json()).toEqual({ value: "ahead", applied: true });
      await wait();
      let real = Date.now();
      expect(await (await putAt("later-on-time", real)).json()).toEqual({ value: "later-on-time", applied: true });
      // Behind by 3 hours: a fresh edit is not "older than everything" because of that clock ...
      await wait();
      skewed = Date.now() - 3 * HOUR;
      expect(await (await putAt("behind", skewed)).json()).toEqual({ value: "behind", applied: true });
      // ... while an edit it made an hour before sending is genuinely older and still loses.
      await wait();
      skewed = Date.now() - 3 * HOUR;
      expect(await (await putAt("made-an-hour-ago", skewed - HOUR, "dayNoteParent", skewed)).json()).toEqual({ value: "behind", applied: false });
      // The same from a device that is ahead and whose offline edit is an hour old.
      skewed = Date.now() + 3 * HOUR;
      expect(await (await putAt("ahead-and-old", skewed - HOUR, "dayNoteParent", skewed)).json()).toEqual({ value: "behind", applied: false });
      real = Date.now();
      expect(await (await putAt("final", real)).json()).toEqual({ value: "final", applied: true });
    });

    it("an older client that does not send its clock reading counts as editing when its request arrives", async () => {
      await putAt(id2, T + 1000);
      // No X-Onden-Client-Now: the absolute editedAt (far in the past or the future) decides nothing.
      expect(await (await put({ value: "no-reading-past", editedAt: T - 9_999_999 }, "dayNoteParent")).json()).toEqual({ value: "no-reading-past", applied: true });
      expect(await (await put({ value: "no-reading-future", editedAt: Date.now() + 7 * 24 * 3_600_000 }, "dayNoteParent")).json()).toEqual({ value: "no-reading-future", applied: true });
      expect(await (await putAt("on-time", Date.now())).json()).toEqual({ value: "on-time", applied: true });
    });

    it("a 'moves forward' key refuses a value behind the stored one whatever the edit times", async () => {
      const visit = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
      expect((await (await putAt(visit(20), T, "rssLastVisit")).json()).applied).toBe(true);
      // a later edit time does not make an earlier visit newer
      expect(await (await putAt(visit(10), T + 9000, "rssLastVisit")).json()).toEqual({ value: visit(20), applied: false });
      expect((await (await putAt(visit(25), T - 9000, "rssLastVisit")).json()).applied).toBe(true);
      // equal is accepted: this device's edit stands
      expect((await (await putAt(visit(25), T, "rssLastVisit")).json()).applied).toBe(true);
      expect(await (await get("rssLastVisit")).json()).toEqual({ value: visit(25) });

      // 「這次更新」 read up to a change: a day behind is refused whatever the edit time
      await putAt("2026-10-28-b", T, "changesSeen");
      expect(await (await putAt("2026-10-27-z", T + 9000, "changesSeen")).json()).toEqual({ value: "2026-10-28-b", applied: false });
      expect((await (await putAt("2026-10-29-a", T - 9000, "changesSeen")).json()).applied).toBe(true);
    });

    it("a 'moves forward' key never moves back, even written without editedAt (a copy saved before the upgrade)", async () => {
      const visit = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
      await put({ value: visit(20) }, "rssLastVisit");
      await put({ value: visit(10) }, "rssLastVisit");
      expect(await (await get("rssLastVisit")).json()).toEqual({ value: visit(20) });
      await put({ value: visit(22) }, "rssLastVisit");
      expect(await (await putAt(visit(5), T, "rssLastVisit")).json()).toEqual({ value: visit(22), applied: false });
    });

    it("two writes at once end with the later edit, whichever statement runs last", async () => {
      for (let round = 0; round < 10; round++) {
        await seedQ("DELETE FROM actor_prefs WHERE actor_id = $1", [ada.id]);
        const base = T + round * 100_000;
        // Edits a second apart, all sent at base + 10 s: the age, not the arrival order, says which is newest.
        const sent = base + 10_000;
        const results = await Promise.all([
          putAt("older-a", base + 1000, "dayNoteParent", sent), putAt("newest", base + 3000, "dayNoteParent", sent),
          putAt("older-b", base + 2000, "dayNoteParent", sent), putAt("oldest", base, "dayNoteParent", sent),
        ]);
        for (const r of results) expect(r.status).toBe(200);
        expect(await (await get("dayNoteParent")).json(), `round ${round}`).toEqual({ value: "newest" });
      }
    });

    it("two visits at once end with the furthest one", async () => {
      const visit = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
      for (let round = 0; round < 10; round++) {
        await seedQ("DELETE FROM actor_prefs WHERE actor_id = $1", [ada.id]);
        await Promise.all([visit(12), visit(20), visit(15), visit(3)].map((v, i) => putAt(v, T + i, "rssLastVisit")));
        expect(await (await get("rssLastVisit")).json(), `round ${round}`).toEqual({ value: visit(20) });
      }
    });

    it("refuses an edit time that is not a positive number, and does not let a far-future clock freeze the key", async () => {
      for (const editedAt of ["now", -1, 0, null, Number.POSITIVE_INFINITY]) {
        expect((await put({ value: id, editedAt }, "dayNoteParent")).status, String(editedAt)).toBe(400);
      }
      expect(await (await get("dayNoteParent")).json()).toEqual({ value: null });
      // a device whose clock is a year ahead is limited to a few minutes ahead
      await putAt(id, Date.now() + 365 * 24 * 3600 * 1000);
      expect((await (await putAt(id2, Date.now() + 10 * 60_000)).json()).applied).toBe(true);
    });
  });

  describe("a write that carries how long ago the edit was made (editAgeMs)", () => {
    const id = "3f0b7a52-3c1e-4d5a-9a3e-2b8f4c7d1e60";
    const id2 = "9a1c2d3e-0000-4000-8000-000000000002";
    const putAge = (value: unknown, editAgeMs: number, extra: Record<string, unknown> = {}) => put({ value, editAgeMs, ...extra }, "dayNoteParent");

    it("the edit made later wins whatever the devices' clocks say, because only ages cross the wire", async () => {
      // A phone whose clock is 10 min slow edited 60 s ago; a laptop whose clock is
      // 10 min fast edited 5 s ago. Their absolute clocks are never sent.
      expect(await (await putAge(id, 60_000)).json()).toEqual({ value: id, applied: true });
      expect(await (await putAge(id2, 5_000)).json()).toEqual({ value: id2, applied: true });
      // an edit made 2 min ago, arriving last, is older than both
      expect(await (await putAge("older", 120_000)).json()).toEqual({ value: id2, applied: false });
      expect(await (await get("dayNoteParent")).json()).toEqual({ value: id2 });
    });

    it("a device clock a few minutes ahead no longer blocks a later edit from another device", async () => {
      // The old way: this device's editedAt (4 min ahead) would be kept as the edit time.
      await putAge(id, 0, { editedAt: Date.now() + 4 * 60_000 });
      await new Promise((r) => setTimeout(r, 20));
      expect(await (await putAge(id2, 0)).json()).toEqual({ value: id2, applied: true });
    });

    it("an age wins over editedAt when both are sent, and a reset keeps its place in time", async () => {
      await putAge(id, 1_000);
      // editedAt says "in the far future"; the age says it is old: refused
      expect(await (await putAge(id2, 600_000, { editedAt: Date.now() + 4 * 60_000 })).json()).toEqual({ value: id, applied: false });
      expect(await (await putAge(null, 0)).json()).toEqual({ value: null, applied: true });
      expect(await (await putAge(id2, 30_000)).json()).toEqual({ value: null, applied: false });
    });

    it("refuses an age that is not a non-negative number", async () => {
      for (const editAgeMs of ["now", -1, null, Number.POSITIVE_INFINITY, 1e15]) {
        expect((await put({ value: id, editAgeMs }, "dayNoteParent")).status, String(editAgeMs)).toBe(400);
      }
      expect(await (await get("dayNoteParent")).json()).toEqual({ value: null });
    });
  });

  it("accepts a write to a retired key (an old page still open) without storing it, and reads it as unset", async () => {
    for (const key of ["journalShutdown", "journalShutdowns"]) {
      const old = key === "journalShutdown" ? { date: "2026-10-26", done: 1, tomorrow: 0, dated: 0, dropped: 0 } : { "2026-10-26": { done: 1 } };
      for (const body of [{ value: old }, { value: old, editAgeMs: 50 }, { value: old, editedAt: Date.now() }, { value: null }]) {
        const res = await put(body, key);
        expect(res.status, key).toBe(200);
        expect(await res.json(), key).toEqual({ value: null, applied: true });
      }
      expect(await (await get(key)).json(), key).toEqual({ value: null });
    }
    expect((await q("SELECT 1 FROM actor_prefs WHERE actor_id = $1", [ada.id])).rowCount).toBe(0);
    // a key that never existed is still refused
    expect((await put({ value: 1 }, "neverExisted")).status).toBe(404);
  });

  it("needs a signed-in person", async () => {
    currentActor = null;
    expect((await get()).status).toBe(401);
    expect((await put({ value: null })).status).toBe(401);
  });

  it("goes with the person", async () => {
    const ws = await getWorkspaceId();
    const gone = await persistActor(ws, { id: "g", name: "Gone", role: "editor", type: "human" });
    currentActor = gone;
    await put({ value: { order: ["tasks"], phone: 1 } });
    await q("DELETE FROM space_members WHERE actor_id = $1", [gone.id]);
    await q("DELETE FROM actors WHERE id = $1", [gone.id]);
    expect((await q("SELECT 1 FROM actor_prefs WHERE actor_id = $1", [gone.id])).rowCount).toBe(0);
  });
});
