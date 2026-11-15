// Migration 145: RSS subscriptions leave the note tree for a table.
//
// The database holds the NEW shape (schema.sql). The test steps it back to the
// shape before 145 — rss_staging.source_node_id pointing at notes, no
// rss_subscriptions — seeds source notes the way migrations 061/114 and
// createSource left them, runs the migration file, reads the result, and rolls
// the whole thing back (DDL is transactional), so no other test sees any of it.
//
//   * a source note with children / a written body / a tag stays, as an
//     ordinary note with no `_rss_*` attribute and its children untouched;
//   * an empty one goes to the trash with a NODE_DELETED (restorable);
//   * staged articles, their saved pointer, tombstones and per-person "seen"
//     marks move with their feed; the subscription keeps the note's id, so a
//     saved article's `_rss_source` still names it;
//   * an article saved before is not saved a second time;
//   * a subscription in a space only someone else belongs to stays theirs;
//   * a source in the trash (an unsubscribed feed) is not carried over;
//   * running the file again changes nothing.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { q, withTransaction } from "../db.js";
import { listSources, getSource } from "../modules/rss/sources.js";
import { saveItem } from "../modules/rss/save.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";
import { rerunMigration } from "./helpers/rerunMigration.js";

registerShippedModules();

// 145, then 181: the columns the source readers select after it (voice, display_mode).
// (rerunMigration also puts back the functions later migrations redefined.)
const runMigration = async () => { await rerunMigration("145_rss_subscriptions_table"); await rerunMigration("181_rss_voice_and_display"); };

class Rollback extends Error {}

type Rows = Record<string, any>[];
type After = {
  ids: Record<string, string>;
  subs: Record<string, Record<string, any>>;
  notes: Record<string, Record<string, any>>;
  attrs: Record<string, string[]>;
  staging: Rows;
  seen: Rows;
  deleteEvents: Rows;
  outbox: Rows;
  visible: { a: string[]; b: string[] };
  readByB: boolean;
  saveAgain: { status: number; body: Record<string, any> };
  saveNew: { first: { status: number; body: Record<string, any> }; second: { status: number; body: Record<string, any> }; notes: number };
  secondRun: { subs: number; notes: Rows };
  tagId: string;
  autoTagId: string;
  creator: string;
  spaces: { aPersonal: string; lab: string };
};

describe.skipIf(!isTestDatabase())("migration 145 — RSS subscriptions table (DB)", () => {
  let after: After;

  beforeAll(async () => {
    const stamp = `${Date.now()}`;
    const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('M145', $1) RETURNING id::text`, [`m145-${randomUUID()}`])).rows[0]!.id;
    // Actors and spaces are real rows: a rolled-back transaction would hide them from the pool,
    // so they are made inside it, with everything else.
    await expect(withTransaction(async () => {
      const a: ActorCtx = await persistActor(ws, { id: "", name: "A", type: "human", role: "editor" });
      const b: ActorCtx = await persistActor(ws, { id: "", name: "B", type: "human", role: "editor" });
      const personal = async (actor: ActorCtx) => (await q<{ id: string }>(
        `SELECT id::text FROM spaces WHERE workspace_id = $1 AND kind = 'personal' AND owner_actor_id::text = $2`, [ws, actor.id])).rows[0]!.id;
      const aSpace = await personal(a);
      const lab = await makeSpace(ws, `Lab ${stamp}`, [{ id: b.id, permission: "edit" }]);

      // ── step the schema back to the shape before 145 ──
      // (ALTER TABLE refuses while deferred checks are pending: run them now.)
      await q(`SET CONSTRAINTS ALL IMMEDIATE`);
      await q(`DELETE FROM rss_staging`);
      await q(`DROP TABLE rss_subscriptions CASCADE`);
      await q(`ALTER TABLE rss_staging RENAME COLUMN subscription_id TO source_node_id`);
      await q(`ALTER TABLE rss_staging RENAME CONSTRAINT rss_staging_subscription_guid_key TO rss_staging_source_guid_key`);
      await q(`ALTER INDEX rss_staging_subscription_ts_idx RENAME TO rss_staging_source_ts_idx`);
      await q(`ALTER TABLE rss_staging ADD CONSTRAINT rss_staging_source_node_id_fkey FOREIGN KEY (source_node_id) REFERENCES content_nodes(id) ON DELETE CASCADE`);

      // ── seed ──
      const ids: Record<string, string> = {};
      const node = async (key: string, o: {
        title?: string; markdown?: string; parent?: string; space?: string; deleted?: boolean; type?: string; sourceType?: string;
      } = {}) => {
        ids[key] = (await seedQ<{ id: string }>(
          `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, space_id, deleted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9 THEN now() END) RETURNING id::text`,
          [ws, o.sourceType ?? "rss", o.type ?? "content", o.title ?? key, `m145-${randomUUID()}`, o.markdown ?? "",
            o.parent ? ids[o.parent] : null, o.type === "class_tag" ? null : (o.space ?? aSpace), o.deleted ?? false])).rows[0]!.id;
      };
      const attr = (key: string, name: string, value: string) =>
        seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, $3, $4)`, [ws, ids[key], name, value]);
      const source = async (key: string, url: string, o: Parameters<typeof node>[1] = {}, attrs: Record<string, string> = {}) => {
        await node(key, { markdown: `Subscribed feed: ${url}\n`, ...o });
        await attr(key, "_rss_kind", "source");
        if (url) await attr(key, "_rss_url", url);
        for (const [name, value] of Object.entries(attrs)) await attr(key, name, value);
      };
      const stage = async (src: string, guid: string, o: { saved?: string; seen?: boolean; tomb?: boolean; title?: string } = {}) =>
        (await q<{ id: string }>(
          `INSERT INTO rss_staging (workspace_id, source_node_id, guid, title, url, body, seen_at, saved_node_id, tombstoned_at)
           VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() END, $8, CASE WHEN $9 THEN now() END) RETURNING id::text`,
          [ws, ids[src], guid, o.title ?? `Article ${guid}`, `https://m145.test/${guid}`, o.tomb ? "" : `<p>${guid}</p>`,
            o.seen ?? false, o.saved ? ids[o.saved] : null, o.tomb ?? false])).rows[0]!.id;

      ids.autoTag = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug) VALUES ($1, 'manual', 'class_tag', $2, $3) RETURNING id::text`,
        [ws, `m145-auto-${stamp}`, `m145-auto-${randomUUID()}`])).rows[0]!.id;
      ids.tag = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug) VALUES ($1, 'manual', 'class_tag', $2, $3) RETURNING id::text`,
        [ws, `m145-tag-${stamp}`, `m145-tag-${randomUUID()}`])).rows[0]!.id;

      // 1. a busy feed: children (one is the saved article), every setting set, an explicit save default.
      await source("busy", "https://m145.test/busy.xml", {}, {
        _rss_etag: '"abc"', _rss_last_modified: "Mon, 26 Oct 2026 10:00:00 GMT", _rss_fetch_interval_minutes: "30",
        _rss_last_fetched_at: "2026-10-28T10:00:00.000Z", _rss_last_error: "HTTP 500", _rss_auto_tag: ids.autoTag!,
        _rss_embed: "true", _rss_auto_dismiss_days: "7", _rss_always_fulltext: "true",
        _rss_default_tags: ids.tag!, _rss_default_parent: ids.autoTag!, // a tag is no parent: dropped
      });
      await node("saved", { title: "Saved article", parent: "busy", markdown: "kept text" });
      await attr("saved", "_rss_guid", "busy-1");
      await attr("saved", "_rss_source", ids.busy!);
      await attr("saved", "_rss_url", "https://m145.test/busy-1");
      await node("filed", { title: "Filed by hand", parent: "busy", markdown: "mine", sourceType: "manual" });
      await q(`INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload)
               VALUES ($1, 'user', $2, 'NODE_CREATED', 'node', $3, '{}')`, [ws, a.id, ids.busy]);
      ids.stSaved = await stage("busy", "busy-1", { saved: "saved", seen: true });
      ids.stOpen = await stage("busy", "busy-2");
      ids.stTomb = await stage("busy", "busy-3", { seen: true, tomb: true });
      await seedQ(`INSERT INTO rss_seen (staging_id, actor_id, seen) VALUES ($1, $2, false)`, [ids.stSaved, a.id]);
      await seedQ(`INSERT INTO rss_seen (staging_id, actor_id, seen) VALUES ($1, $2, true)`, [ids.stOpen, b.id]);

      // 2. never touched: nothing hangs off it.
      await source("empty", "https://m145.test/empty.xml");
      // 3. someone wrote in it.
      await source("written", "https://m145.test/written.xml", { markdown: "My notes on this blog\n" });
      // 4. the legacy save default: its own tag + an auto tag, filed under the note (kept: it is tagged).
      await source("legacyTagged", "https://m145.test/legacy.xml", {}, { _rss_auto_tag: `m145-auto-${stamp}` });
      await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [ids.legacyTagged, ids.tag]);
      // 5. the legacy default on a note that goes: the tags stay, there is no parent to file under.
      await source("legacyEmpty", "https://m145.test/legacy-empty.xml", {}, { _rss_auto_tag: ids.autoTag! });
      // 6. an unsubscribed feed (its note is in the trash), with its stream.
      await source("trashed", "https://m145.test/trashed.xml", { deleted: true });
      await stage("trashed", "trashed-1", { tomb: true });
      // 7. a marker with no feed address.
      await source("noUrl", "");
      // 8. a feed in a space only B belongs to.
      await source("lab", "https://m145.test/lab.xml", { space: lab });
      ids.stLab = await stage("lab", "lab-1");
      // 9. a plain note carrying an article link: not a source.
      await node("plain", { markdown: "x" });
      await attr("plain", "_rss_url", "https://m145.test/plain");
      // 10. queued fetches name the source note.
      await q(`INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload) VALUES ($1, 'rss_fetch', $2, $3)`,
        [ws, `rss_fetch:${ids.busy}`, JSON.stringify({ workspaceId: ws, sourceNodeId: ids.busy })]);

      // ── run ──
      await q(`SET CONSTRAINTS ALL IMMEDIATE`);
      await runMigration();

      // ── read ──
      const all = Object.entries(ids).filter(([k]) => !k.startsWith("st") && !["autoTag", "tag"].includes(k));
      const nodeIds = all.map(([, id]) => id);
      const byId = new Map(all.map(([k, id]) => [id, k]));
      const subs = Object.fromEntries((await q<Record<string, any>>(
        `SELECT id::text, space_id::text, title, url, created_by_actor_id::text, created_at, etag, last_modified, fetch_interval_minutes,
                last_fetched_at, last_error, auto_tag_id::text, embed, auto_dismiss_days, default_tag_ids::text[], default_parent_id::text, always_fulltext
           FROM rss_subscriptions WHERE workspace_id = $1`, [ws])).rows.map((r) => [byId.get(r.id) ?? r.id, r]));
      const notes = Object.fromEntries((await q<Record<string, any>>(
        `SELECT id::text, node_type, source_type, parent_id::text, deleted_at, deleted_by_event_id::text, markdown, title
           FROM content_nodes WHERE id = ANY($1::uuid[])`, [nodeIds])).rows.map((r) => [byId.get(r.id)!, r]));
      const attrs: Record<string, string[]> = {};
      for (const r of (await q<{ node_id: string; key: string }>(
        `SELECT node_id::text, key FROM node_attributes WHERE node_id = ANY($1::uuid[]) ORDER BY key`, [nodeIds])).rows) {
        (attrs[byId.get(r.node_id)!] ??= []).push(r.key);
      }
      const staging = (await q<Rows[number]>(
        `SELECT id::text, subscription_id::text, guid, saved_node_id::text, tombstoned_at IS NOT NULL AS tombstoned, seen_at IS NOT NULL AS seen, body
           FROM rss_staging WHERE workspace_id = $1 ORDER BY guid`, [ws])).rows;
      const seen = (await q<Rows[number]>(`SELECT staging_id::text, actor_id, seen FROM rss_seen WHERE staging_id = ANY($1::uuid[])`,
        [[ids.stSaved, ids.stOpen]])).rows;
      const deleteEvents = (await q<Rows[number]>(
        `SELECT id::text, actor_type, actor_id, target_id, event_type, tx_meta->>'inverse_op' AS inverse_op
           FROM domain_events WHERE workspace_id = $1 AND event_type = 'NODE_DELETED'`, [ws])).rows;
      const outbox = (await q<Rows[number]>(`SELECT 1 FROM outbox WHERE effect_kind = 'rss_fetch' AND workspace_id = $1`, [ws])).rows;

      const visible = {
        a: (await listSources(a, ws)).map((s) => byId.get(s.id) ?? s.id).sort(),
        b: (await listSources(b, ws)).map((s) => byId.get(s.id) ?? s.id).sort(),
      };
      const readByB = (await getSource(b, ws, ids.busy!)) !== null;

      // An article that was saved before is not saved a second time...
      const saveAgain = await saveItem(a, ws, ids.stSaved!, undefined);
      // ...and a new one is saved once, whatever the repeat.
      const saveNew = { first: await saveItem(a, ws, ids.stOpen!, undefined), second: await saveItem(a, ws, ids.stOpen!, undefined), notes: 0 };
      saveNew.notes = (await q(
        `SELECT 1 FROM node_attributes WHERE key = '_rss_source' AND value = $1 AND node_id <> $2`, [ids.busy, ids.saved])).rows.length;

      // ── run again: nothing changes ──
      const countSubs = async () => (await q(`SELECT 1 FROM rss_subscriptions WHERE workspace_id = $1`, [ws])).rows.length;
      const noteState = async () => (await q<Rows[number]>(
        `SELECT id::text, deleted_at, source_type, parent_id::text FROM content_nodes WHERE id = ANY($1::uuid[]) ORDER BY id`, [nodeIds])).rows;
      const notesBefore = await noteState();
      const subsBefore = await countSubs();
      await runMigration();
      const secondRun = { subs: (await countSubs()) - subsBefore, notes: [] as Rows };
      const notesAfter = await noteState();
      secondRun.notes = notesAfter.filter((r, i) => JSON.stringify(r) !== JSON.stringify(notesBefore[i]));

      after = {
        ids, subs, notes, attrs, staging, seen, deleteEvents, outbox, visible, readByB, saveAgain, saveNew, secondRun,
        tagId: ids.tag!, autoTagId: ids.autoTag!, creator: a.id, spaces: { aPersonal: aSpace, lab },
      };
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    await q(`DELETE FROM workspaces WHERE id = $1`, [ws]);
  }, 60_000);

  it("carries every live source with a feed address into the table, keeping the note's id and every setting", () => {
    const { ids, subs, spaces } = after;
    expect(Object.keys(subs).sort()).toEqual(["busy", "empty", "lab", "legacyEmpty", "legacyTagged", "written"]);
    expect(subs.busy).toMatchObject({
      id: ids.busy, space_id: spaces.aPersonal, title: "busy", url: "https://m145.test/busy.xml", created_by_actor_id: after.creator,
      etag: '"abc"', last_modified: "Mon, 26 Oct 2026 10:00:00 GMT", fetch_interval_minutes: 30, last_error: "HTTP 500",
      auto_tag_id: after.autoTagId, embed: true, auto_dismiss_days: 7, always_fulltext: true,
    });
    expect(new Date(subs.busy!.last_fetched_at).toISOString()).toBe("2026-10-28T10:00:00.000Z");
    // The explicit save default: the tag, and no parent (the stored "parent" was a tag).
    expect(subs.busy).toMatchObject({ default_tag_ids: [after.tagId], default_parent_id: null });
    // Untouched settings take the column defaults; nothing explicit means no save default.
    expect(subs.empty).toMatchObject({ fetch_interval_minutes: 60, embed: false, always_fulltext: false, auto_dismiss_days: null,
      default_tag_ids: null, default_parent_id: null, last_fetched_at: null, created_by_actor_id: null });
  });

  it("a source note with children, a written body or a tag stays as an ordinary note; its children are not touched", () => {
    const { ids, notes, attrs } = after;
    for (const key of ["busy", "written", "legacyTagged"]) {
      expect(notes[key], key).toMatchObject({ node_type: "content", deleted_at: null, source_type: "manual" });
      expect(attrs[key]?.filter((k) => k.startsWith("_rss_")) ?? [], key).toEqual([]);
    }
    expect(notes.written!.markdown).toBe("My notes on this blog\n");
    expect(notes.saved).toMatchObject({ parent_id: ids.busy, deleted_at: null, source_type: "rss", markdown: "kept text" });
    expect(notes.filed).toMatchObject({ parent_id: ids.busy, deleted_at: null });
    // The article keeps its provenance, which names the subscription (same id as the note had).
    expect(attrs.saved).toEqual(["_rss_guid", "_rss_source", "_rss_url"]);
  });

  it("the legacy save default (own tags + auto tag, under the note) becomes an explicit one", () => {
    const { ids, subs } = after;
    expect(subs.legacyTagged).toMatchObject({ default_tag_ids: [after.tagId, after.autoTagId], default_parent_id: ids.legacyTagged, auto_tag_id: after.autoTagId });
    // The note goes, so there is no parent to file under.
    expect(subs.legacyEmpty).toMatchObject({ default_tag_ids: [after.autoTagId], default_parent_id: null });
  });

  it("an empty source note goes to the trash, restorable, and nothing else does", () => {
    const { notes, deleteEvents, ids } = after;
    for (const key of ["empty", "legacyEmpty", "lab"]) {
      expect(notes[key]!.deleted_at, key).not.toBeNull();
      const event = deleteEvents.find((e) => e.target_id === ids[key]);
      expect(event, key).toMatchObject({ actor_type: "system", actor_id: "migration:145", inverse_op: "node.undeleted" });
      expect(notes[key]!.deleted_by_event_id, key).toBe(event!.id);
    }
    expect(deleteEvents.map((e) => e.target_id).sort()).toEqual(["empty", "legacyEmpty", "lab"].map((k) => ids[k]!).sort());
    // Already in the trash: stays there, only its feed attributes go. No feed address: stays where it is.
    expect(notes.trashed!.deleted_at).not.toBeNull();
    expect(notes.noUrl!.deleted_at).toBeNull();
    expect(after.attrs.trashed ?? []).toEqual([]);
    expect(after.attrs.noUrl ?? []).toEqual([]);
    // A plain note with an article link is not touched.
    expect(notes.plain).toMatchObject({ deleted_at: null, source_type: "rss" });
    expect(after.attrs.plain).toEqual(["_rss_url"]);
  });

  it("staged articles, their saved pointer, tombstones and the per-person seen marks move with their feed", () => {
    const { ids, staging, seen } = after;
    expect(staging.map((r) => `${r.guid}:${r.subscription_id === ids.busy ? "busy" : r.subscription_id === ids.lab ? "lab" : "?"}`))
      .toEqual(["busy-1:busy", "busy-2:busy", "busy-3:busy", "lab-1:lab"]); // the trashed feed's stream is gone
    const row = (guid: string) => staging.find((r) => r.guid === guid)!;
    expect(row("busy-1")).toMatchObject({ saved_node_id: ids.saved, seen: true, tombstoned: false });
    expect(row("busy-2")).toMatchObject({ saved_node_id: null, seen: false, tombstoned: false, body: "<p>busy-2</p>" });
    expect(row("busy-3")).toMatchObject({ tombstoned: true, body: "" });
    expect(seen).toEqual(expect.arrayContaining([
      expect.objectContaining({ staging_id: ids.stSaved, seen: false }),
      expect.objectContaining({ staging_id: ids.stOpen, seen: true }),
    ]));
    expect(seen).toHaveLength(2);
  });

  it("an article saved before is not saved a second time; a new one is saved once", () => {
    const { saveAgain, saveNew, ids } = after;
    expect(saveAgain.status).toBe(200);
    expect(saveAgain.body).toMatchObject({ node_id: ids.saved, already_saved: true });
    expect(saveNew.first.status).toBe(201);
    expect(saveNew.second.status).toBe(200);
    expect(saveNew.second.body).toMatchObject({ node_id: saveNew.first.body.node_id, already_saved: true });
    expect(saveNew.notes).toBe(1);
  });

  it("a subscription in another space is theirs: the other person neither lists nor reads it", () => {
    const { visible, readByB } = after;
    expect(visible.a).toEqual(["busy", "empty", "legacyEmpty", "legacyTagged", "written"]);
    expect(visible.b).toEqual(["lab"]);
    expect(readByB).toBe(false);
  });

  it("queued fetches that named the source note are dropped (the scheduler files fresh ones)", () => {
    expect(after.outbox).toEqual([]);
  });

  it("running it again changes nothing", () => {
    expect(after.secondRun).toEqual({ subs: 0, notes: [] });
  });
});
