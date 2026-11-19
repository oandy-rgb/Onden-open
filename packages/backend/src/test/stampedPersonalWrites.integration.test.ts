// Personal data and settings go through the one write entry (spine/mutate.ts mutatePersonal) without a history event
// (causal-stamps proposal §3, S4): each write is one transaction with one write stamp, the stamp trigger records it on the
// tables that have one (migration 198), a delete leaves a tombstone, and nothing lands in the event log or in a response.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getWorkspaceId, pool, q, allowUnstampedWrite } from "../db.js";
import { mutatePersonal } from "../spine/mutate.js";
import { countWritesWithoutStamp } from "../spine/stamps.js";
import { addCalendar, changeCalendar, removeCalendar, listCalendars } from "../modules/external_calendars/store.js";
import { muteKeyword, endMute, listMutes } from "../modules/rss/mutes.js";
import { createSource, recordFetch } from "../modules/rss/sources.js";
import { updateSource, unsubscribe } from "../modules/rss/subscriptions.js";
import { writePref } from "../services/actorPrefs.js";
import { replaceSettings, patchSettings, clearSettings } from "../modules/review/service.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { createNote } from "../services/noteCreate.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

type StampRow = { field: string; seq: number; deleted: boolean; author: string | null };

describe.skipIf(!isTestDb)("personal writes through the write entry", () => {
  let ws = "";
  let ada!: ActorCtx;
  let space = "";
  const savedKey = process.env.ONDEN_SECRET_KEY;

  const stamps = async (table: string, key: string): Promise<Map<string, StampRow>> => new Map((await q<StampRow>(
    `SELECT field, seq::int, deleted, author FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3`,
    [ws, table, key])).rows.map((r) => [r.field, r]));
  const nextSeq = async () => Number((await q<{ n: string }>(`SELECT next_seq::text AS n FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0]?.n ?? "1");
  const eventCount = async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1`, [ws])).rows[0]!.n);

  /** What one write did: the sequence numbers it used, the writes that skipped the entry, and the events it added. */
  async function measured<T>(write: () => Promise<T>): Promise<{ result: T; stampsUsed: number; bypassed: number; events: number }> {
    const [seq, bypass, events] = [await nextSeq(), await countWritesWithoutStamp(ws), await eventCount()];
    const result = await write();
    return { result, stampsUsed: (await nextSeq()) - seq, bypassed: (await countWritesWithoutStamp(ws)) - bypass, events: (await eventCount()) - events };
  }

  beforeAll(async () => {
    process.env.ONDEN_SECRET_KEY = randomBytes(32).toString("hex");
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    ada = await persistActor(ws, { id: "", name: "Personal Ada", role: "admin", type: "human" });
    space = await makeSpace(ws, `personal ${Date.now()}`, [{ id: ada.id, permission: "edit" }]);
  });
  afterAll(async () => {
    if (savedKey === undefined) delete process.env.ONDEN_SECRET_KEY; else process.env.ONDEN_SECRET_KEY = savedKey;
    await pool.end();
  });

  it("an external calendar: stamped on add, on each setting that changes, tombstoned on delete; no event, one stamp per write", async () => {
    const id = randomUUID();
    const added = await measured(() => addCalendar(ws, ada, { id, name: "Work", color: "#3b82f6", href: "https://calendar.example.com/a.ics", host: "calendar.example.com" }));
    expect(added).toMatchObject({ stampsUsed: 1, bypassed: 0, events: 0 });
    const first = await stamps("external_calendars", id);
    expect(first.get("*")).toMatchObject({ deleted: false, author: ada.id });
    // a changed setting is stamped on its own field, with a later sequence number than the row's
    const renamed = await measured(() => changeCalendar(ws, ada, id, { name: "Home" }));
    expect(renamed).toMatchObject({ stampsUsed: 1, bypassed: 0, events: 0 });
    const second = await stamps("external_calendars", id);
    expect(second.get("name")!.seq).toBeGreaterThan(first.get("*")!.seq);
    expect(second.has("color")).toBe(false);
    // the fetch state is the fetching node's own: no stamp, nothing counted
    await measured(async () => {
      await allowUnstampedWrite("test: calendar fetch state", () => q(`UPDATE external_calendars SET last_attempt_at = now() WHERE id = $1`, [id]));
    }).then((r) => expect(r).toMatchObject({ stampsUsed: 0, bypassed: 0 }));
    expect((await stamps("external_calendars", id)).get("name")!.seq).toBe(second.get("name")!.seq);
    const removed = await measured(() => removeCalendar(ws, ada, id));
    expect(removed).toMatchObject({ stampsUsed: 1, bypassed: 0, events: 0 });
    const gone = await stamps("external_calendars", id);
    expect(gone.get("*")).toMatchObject({ deleted: true });
    expect(gone.size).toBe(1); // the field stamps go, the tombstone stays
    expect((await listCalendars(ada)).some((c) => c.id === id)).toBe(false);
  });

  it("an RSS mute: stamped on creation and on being extended, tombstoned when ended early", async () => {
    const made = await measured(() => muteKeyword(ada, ws, `stamp-${randomUUID().slice(0, 6)}`));
    expect(made).toMatchObject({ stampsUsed: 1, bypassed: 0, events: 0 });
    const id = made.result;
    expect((await stamps("rss_mutes", id)).get("*")).toMatchObject({ deleted: false, author: ada.id });
    const ended = await measured(() => endMute(ada, ws, id));
    expect(ended).toMatchObject({ result: true, stampsUsed: 1, bypassed: 0, events: 0 });
    expect((await stamps("rss_mutes", id)).get("*")).toMatchObject({ deleted: true });
    expect((await listMutes(ada, ws)).some((m) => m.id === id)).toBe(false);
  });

  it("RSS subscription settings are stamped, the fetch state is not, unsubscribing leaves a tombstone", async () => {
    const created = await measured(() => mutatePersonal({ actor: ada, workspaceId: ws, apply: ({ actor }) =>
      createSource(ws, actor, { url: `https://feeds.example.com/${randomUUID()}.xml`, title: "Feed", spaceId: space }) }));
    expect(created).toMatchObject({ stampsUsed: 1, bypassed: 0, events: 0 });
    const id = created.result.id;
    expect((await stamps("rss_subscriptions", id)).get("*")).toMatchObject({ deleted: false, author: ada.id });
    const changed = await measured(() => updateSource(ada, ws, id, { alwaysFulltext: true }));
    expect(changed.result.status).toBe(200);
    expect(changed).toMatchObject({ stampsUsed: 1, bypassed: 0, events: 0 });
    const afterChange = await stamps("rss_subscriptions", id);
    expect(afterChange.get("fulltext")!.seq).toBeGreaterThan(afterChange.get("*")!.seq);
    // an hourly fetch records etag and last fetch: not a setting, no stamp, no entry needed
    const fetched = await measured(() => recordFetch(ws, id, { ok: true, etag: "abc", lastModified: null }));
    expect(fetched).toMatchObject({ stampsUsed: 0, bypassed: 0, events: 0 });
    const unsubscribed = await measured(() => unsubscribe(ada, ws, id));
    expect(unsubscribed.result.status).toBe(200);
    expect(unsubscribed).toMatchObject({ stampsUsed: 1, bypassed: 0, events: 0 });
    expect((await stamps("rss_subscriptions", id)).get("*")).toMatchObject({ deleted: true });
  });

  it("preferences, and personal review settings: one stamp per write, no event, nothing counted as skipping the entry", async () => {
    const pref = await measured(() => writePref(ada, "dayNoteParent", randomUUID()));
    expect(pref).toMatchObject({ stampsUsed: 1, bypassed: 0, events: 0 });
    expect(await measured(() => writePref(ada, "dayNoteParent", null))).toMatchObject({ stampsUsed: 1, bypassed: 0, events: 0 });
    const { tagId: tag } = await seedClassTag(ws, { name: `stamp-review-${Date.now()}` });
    expect(await measured(() => replaceSettings(ada, tag, { maximum_interval_days: 5 }))).toMatchObject({ stampsUsed: 1, bypassed: 0, events: 0 });
    expect((await stamps("actor_module_settings", `${ada.id}/${tag}`)).get("*")).toMatchObject({ deleted: false, author: ada.id });
    expect(await measured(() => patchSettings(ada, tag, { maximum_interval_days: 7 }))).toMatchObject({ stampsUsed: 1, bypassed: 0, events: 0 });
    expect(await measured(() => clearSettings(ada, tag))).toMatchObject({ stampsUsed: 1, bypassed: 0, events: 0 });
    expect((await stamps("actor_module_settings", `${ada.id}/${tag}`)).get("*")).toMatchObject({ deleted: true });
  });

  it("a person's review settings go with their tag note when it is purged: no error, the tag note's own tombstone covers them", async () => {
    const { tagId: tag } = await seedClassTag(ws, { name: `stamp-purge-${Date.now()}` });
    await replaceSettings(ada, tag, { maximum_interval_days: 3 });
    expect((await stamps("actor_module_settings", `${ada.id}/${tag}`)).get("*")).toMatchObject({ deleted: false });
    // the settings row is deleted by the foreign key as the note goes; its delete trigger can no longer find the workspace through the note
    await mutatePersonal({ actor: ada, workspaceId: ws, apply: () => q(`DELETE FROM content_nodes WHERE id = $1`, [tag]) });
    expect((await q(`SELECT 1 FROM actor_module_settings WHERE tag_id = $1`, [tag])).rowCount).toBe(0);
    expect((await stamps("content_nodes", tag)).get("*")).toMatchObject({ deleted: true });
    const left = await stamps("actor_module_settings", `${ada.id}/${tag}`);
    expect([...left.values()].every((r) => r.deleted === false)).toBe(true); // nothing was written for the cascade, and nothing failed
  });

  it("two personal writes in one entry call share one stamp (same transaction, same stamp)", async () => {
    const calendar = randomUUID();
    await addCalendar(ws, ada, { id: calendar, name: "Pair", color: "#111111", href: "https://calendar.example.com/p.ics", host: "calendar.example.com" });
    const keyword = `pair-${randomUUID().slice(0, 6)}`;
    const both = await measured(() => mutatePersonal({ actor: ada, workspaceId: ws, apply: async () => {
      await q(`UPDATE external_calendars SET enabled = false WHERE id = $1`, [calendar]);
      return (await q<{ id: string }>(`INSERT INTO rss_mutes (workspace_id, actor_id, keyword, expires_at) VALUES ($1, $2, $3, now() + interval '1 day') RETURNING id::text`, [ws, ada.id, keyword])).rows[0]!.id;
    } }));
    expect(both).toMatchObject({ stampsUsed: 1, bypassed: 0, events: 0 });
    expect((await stamps("external_calendars", calendar)).get("enabled")!.seq)
      .toBe((await stamps("rss_mutes", both.result)).get("*")!.seq);
  });

  it("a stamped personal table cannot be written outside the entry (tests refuse it)", async () => {
    await expect(q(`DELETE FROM actor_prefs WHERE actor_id = $1`, [ada.id])).rejects.toThrow(/outside a stamped transaction/);
    await expect(q(`UPDATE external_calendars SET enabled = true WHERE actor_id = $1`, [ada.id])).rejects.toThrow(/outside a stamped transaction/);
    // a fixture says it is one; the entry needs no say
    await seedQ(`DELETE FROM actor_prefs WHERE actor_id = $1`, [ada.id]);
    await mutatePersonal({ actor: ada, workspaceId: ws, apply: () => q(`DELETE FROM actor_prefs WHERE actor_id = $1`, [ada.id]) });
  });

  describe("two connections", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // A personal write now waits behind the workspace write lock like any entry write (it did not before): it must wait, not fail,
    // and a note write and a personal write racing in either order must never deadlock.
    it.skipIf(needsSecondConnection)("a personal write waits for a transaction holding the workspace lock and then completes", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let holding!: () => void;
      const held = new Promise<void>((r) => { holding = r; });
      const long = withEventTransaction(ws, async () => { holding(); await gate; });
      await held;
      const write = writePref(ada, "dayNoteParent", null).then(() => "finished");
      expect(await Promise.race([write, sleep(300).then(() => "waiting")])).toBe("waiting");
      release();
      await long;
      expect(await write).toBe("finished");
    });

    it.skipIf(needsSecondConnection)("personal writes and note writes racing in either order never deadlock", async () => {
      const note = (title: string) => createNote({ actor: ada, workspaceId: ws, title, markdown: "x", spaceId: space, event: { uiContext: "node.create" } });
      const jitter = () => sleep(Math.floor(Math.random() * 10));
      for (let i = 0; i < 20; i++) {
        await Promise.race([
          Promise.all([
            (async () => { await jitter(); await note(`race note ${i}`); })(),
            (async () => { await writePref(ada, "dayNoteParent", randomUUID()); await jitter(); await muteKeyword(ada, ws, `race-${i}-${randomUUID().slice(0, 4)}`); })(),
          ]),
          sleep(20_000).then(() => { throw new Error(`round ${i} did not finish`); }),
        ]);
      }
    }, 120_000);
  });

  it("no response carries a stamp", async () => {
    const id = randomUUID();
    await addCalendar(ws, ada, { id, name: "Shown", color: "#222222", href: "https://calendar.example.com/s.ics", host: "calendar.example.com" });
    const shown = JSON.stringify([await listCalendars(ada), await listMutes(ada, ws)]);
    for (const word of ["hlc", "origin", "row_key", "onden.stamp", "sync_stamps"]) expect(shown).not.toContain(word);
  });
});
