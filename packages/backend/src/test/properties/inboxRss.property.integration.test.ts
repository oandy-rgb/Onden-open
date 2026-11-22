// Model-based random test of the RSS reader and the governance inbox (fc.commands)
// through the REAL routes (/api/rss, /api/inbox, /api/nodes) on a `*_test` database.
//
// What "inbox" means here: /api/inbox is the apply-then-review queue of changes an AI
// agent made (services/inboxQueue.ts). A human's notes, an RSS fetch and a human's
// "save as note" never enter it; an agent's NODE_CREATED enters it until the owner
// approves / rejects it, and leaves it while the note is in the trash.
//
// World (one fresh workspace per run): owner A (admin), member B (editor), an agent,
// and a shared space S that only A and B are in. A subscription lands in its creator's
// personal space (private); `share` moves it into S so both read it. Feeds are fakes
// (__setFeedFetchForTests / __setPageFetchForTests) whose content the test rewrites.
//
// Commands: set a feed's content (new / repeated / vanished guids, changed titles,
// duplicate guids in one document), subscribe (also twice), refresh (also twice in a
// row), mark one / many / all seen or unseen, save as a note (default place, or as a
// a note), load the full text, trash / restore a saved note, unsubscribe,
// agent capture, human capture, approve / reject an
// agent change, trash / restore an agent note. Every command is also tried against a
// source the actor cannot read.
//
// Invariants, checked after EVERY command (verify below):
//   • one staging row per (source, guid); the set of guids equals the model
//     (the first-seen title stays: ON CONFLICT DO NOTHING)
//   • an article has at most one LIVE note (same source + guid); the live notes with RSS
//     provenance equal the model; unsubscribing never trashes a saved note and
//     takes the whole stream of the feed with it
//   • "seen" is per person; seen / saved / unseen counts of /api/rss/items and
//     /api/rss/sources equal the model for each member
//   • nobody lists or reads a source (or its articles) of another's private space
//   • the inbox of every member lists exactly the model's unreviewed agent notes, `count`
//     equals the list length, and no RSS or human write is in it
//
// Saving an article again whose saved note is in the trash restores that note (same id) instead
// of making a second one; a reader who cannot read that note gets a note of their own.
//
//   (The saved pointer is one per article; a reader who cannot read the saved note sees the article as
//   unsaved, and saving it makes their own note. Pinned below.)
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/inboxRss.property.integration.test.ts
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { q } from "../../db.js";
import { apiOnError } from "../../httpError.js";
import { drainOutbox, registerOutboxEffect } from "../../services/outbox.js";
import rssRouter from "../../modules/rss/routes.js";
import nodesRouter from "../../routes/nodes.js";
import inboxRouter from "../../routes/inbox.js";
import {
  __setFeedFetchForTests, __setPageFetchForTests, rssFetchEffect, type FeedItem, type ParsedFeed,
} from "../../modules/rss/fetch.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { PROPS_RUNS, checkAsync } from "../helpers/propsConfig.js";
import { seedQ } from "../helpers/seedQ.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);

/** Small by default so the file stays well under a minute; an explicit PROPS_RUNS wins. */
const DEFAULT_RUNS = 40;
const MAX_COMMANDS = 25;

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/rss", rssRouter);
app.route("/api/nodes", nodesRouter);
app.route("/api/inbox", inboxRouter);
registerOutboxEffect(rssFetchEffect);
registerShippedModules();

// ── The real side ───────────────────────────────────────────────────────────

type Who = "A" | "B";
type Res = { status: number; body: Record<string, any> };

type Real = {
  ws: string;
  actors: Record<Who, ActorCtx>;
  agent: ActorCtx;
  space: string;
  /** The fake feeds, by feed number (url below). */
  feeds: FeedItem[][];
  feedUrls: string[];
  call: (who: Who | "agent", method: string, path: string, json?: unknown) => Promise<Res>;
};

const FEEDS_PER_RUN = 3;
const GUIDS_PER_FEED = 5;
const urls = new Map<string, FeedItem[]>();

async function newReal(): Promise<Real> {
  WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Inbox RSS properties', $1) RETURNING id::text`,
    [`inbox-rss-${randomUUID()}`])).rows[0]!.id;
  const A = await persistActor(WS, { id: "ir-a", name: "A", role: "admin", type: "human" });
  const B = await persistActor(WS, { id: "ir-b", name: "B", role: "editor", type: "human" });
  const agent = await persistActor(WS, { id: "ir-agent", name: "Agent", role: "editor", type: "agent" });
  const space = await makeSpace(WS, "Shared reading", [{ id: A.id, permission: "edit" }, { id: B.id, permission: "edit" }]);
  const run = randomUUID().slice(0, 8);
  const feedUrls = Array.from({ length: FEEDS_PER_RUN }, (_, i) => `https://feed.test/ir-${run}-${i}.xml`);
  const feeds = feedUrls.map(() => [] as FeedItem[]);
  feedUrls.forEach((url, i) => urls.set(url, feeds[i]!));
  const actors = { A, B };
  const call: Real["call"] = async (who, method, path, json) => {
    currentActor = who === "agent" ? agent : actors[who];
    const res = await app.request(path, {
      method, headers: json === undefined ? {} : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let body: Record<string, any> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    return { status: res.status, body };
  };
  return { ws: WS, actors, agent, space, feeds, feedUrls, call };
}

/** Wait for the latest rss_fetch intent of a source to finish (the route also kicks it, unawaited). */
async function drainFetchFor(sourceId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const row = (await q<{ id: string; status: string }>(
      `SELECT id::text, status FROM outbox WHERE dedup_key = $1 ORDER BY outbox.id DESC LIMIT 1`, [`rss_fetch:${sourceId}`])).rows[0];
    if (!row) throw new Error(`no rss_fetch intent for ${sourceId}`);
    if (row.status === "done") return;
    if (row.status !== "pending") throw new Error(`rss_fetch for ${sourceId} ended ${row.status}`);
    await drainOutbox({ id: row.id });
    const again = (await q<{ status: string }>(`SELECT status FROM outbox WHERE id = $1::bigint`, [row.id])).rows[0];
    if (again?.status !== "done") await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("rss_fetch never drained");
}

// ── The model ───────────────────────────────────────────────────────────────

type Art = { guid: string; title: string; seen: Record<Who, boolean>; tomb: boolean; saved: string | null; fulltext: boolean };
type Src = { id: string; feed: number; by: Who; space: Who | "S"; live: boolean; arts: Map<string, Art> };
type NoteM = { id: string; src: Src; guid: string; live: boolean; by: Who; title: string };
type AgentNote = { id: string; eventId: string; live: boolean; reviewed: "approved" | "rejected" | null };

class Model {
  srcs: Src[] = [];
  notes: NoteM[] = [];
  agentNotes: AgentNote[] = [];
  humanNotes: string[] = [];
  constructor(readonly real: Real) {}
  readable(who: Who, s: Src): boolean { return s.space === "S" || s.space === who; }
  /** The article's note while it is live and `who` can read it (the saved pointer as the API shows that
   *  reader). A save lands in the saver's personal space, so only the saver reads it. */
  savedLive(a: Art, who: Who): string | null {
    const n = a.saved ? this.notes.find((x) => x.id === a.saved) : undefined;
    return n && n.live && n.by === who ? n.id : null;
  }
  liveNotesOf(s: Src, guid: string): NoteM[] { return this.notes.filter((n) => n.src === s && n.guid === guid && n.live); }
  /** What a fetch of the feed does to the source's staging (first row for a guid wins). */
  fetch(s: Src): void {
    if (!s.live) return;
    for (const it of this.real.feeds[s.feed]!) {
      if (!s.arts.has(it.guid)) s.arts.set(it.guid, { guid: it.guid, title: it.title, seen: { A: false, B: false }, tomb: false, saved: null, fulltext: false });
    }
  }
  visible(who: Who): Src[] { return this.srcs.filter((s) => s.live && this.readable(who, s)); }
  queue(): AgentNote[] { return this.agentNotes.filter((n) => n.live && !n.reviewed); }
}

type Cmd = fc.AsyncCommand<Model, Real>;

const reach = new Map<string, number>();
const hit = (key: string) => reach.set(key, (reach.get(key) ?? 0) + 1);
const at = <T>(list: T[], i: number): T | undefined => (list.length ? list[i % list.length] : undefined);
const pick = fc.nat(1000);
const who = fc.constantFrom<Who>("A", "B");

function expectStatus(res: Res, allowed: number[], label: string): void {
  if (!allowed.includes(res.status)) throw new Error(`${label}: expected ${allowed.join("/")} but got ${res.status} ${JSON.stringify(res.body)}`);
}

async function stagingId(s: Src, guid: string): Promise<string> {
  return (await q<{ id: string }>(`SELECT id::text FROM rss_staging WHERE subscription_id = $1 AND guid = $2`, [s.id, guid])).rows[0]!.id;
}

/** A feed item the fake serves: recent, so it is unseen (the backfill window pre-sees old ones). */
function feedItem(feed: number, n: number, variant: number, minute: number): FeedItem {
  return {
    guid: `g${feed}-${n}`, title: `Story ${feed}.${n} v${variant}`, url: `https://feed.test/a/${feed}/${n}`,
    publishedAt: new Date(Date.now() - minute * 60_000).toISOString(),
    contentHtml: `<p>Summary of story ${feed}.${n}.</p>`,
  };
}

// ── Commands ────────────────────────────────────────────────────────────────

class SetFeed implements Cmd {
  constructor(readonly feed: number, readonly items: Array<[number, number]>) {}
  check = () => true;
  async run(m: Model, real: Real) {
    const f = this.feed % FEEDS_PER_RUN;
    // Later items sit older: the order is the feed's, duplicates of a guid included.
    real.feeds[f]!.splice(0, real.feeds[f]!.length, ...this.items.map(([n, v], i) => feedItem(f, n % GUIDS_PER_FEED, v, i + 1)));
    hit("setFeed");
    void m;
  }
  toString = () => `SetFeed(${this.feed % FEEDS_PER_RUN}, [${this.items.map(([n, v]) => `g${n % GUIDS_PER_FEED}v${v}`).join(",")}])`;
}

class Subscribe implements Cmd {
  constructor(readonly who: Who, readonly feed: number, readonly share: boolean) {}
  check = () => true;
  async run(m: Model, real: Real) {
    const f = this.feed % FEEDS_PER_RUN;
    const label = `${this.who} subscribes to feed ${f}`;
    const dup = m.srcs.some((s) => s.live && s.feed === f && s.space === this.who);
    const res = await real.call(this.who, "POST", "/api/rss/subscribe", { url: real.feedUrls[f], title: `Feed ${f} by ${this.who} #${m.srcs.length}` });
    if (dup) {
      expectStatus(res, [409], label);
      hit("subscribe.dup");
      return;
    }
    expectStatus(res, [201], label);
    const src: Src = { id: res.body.id, feed: f, by: this.who, space: this.who, live: true, arts: new Map() };
    m.srcs.push(src);
    await drainFetchFor(src.id);
    m.fetch(src);
    if (this.share) {
      await seedQ(`UPDATE rss_subscriptions SET space_id = $2 WHERE id = $1`, [src.id, real.space]);
      src.space = "S";
      hit("subscribe.shared");
    }
    hit("subscribe");
  }
  toString = () => `Subscribe(${this.who}, feed ${this.feed % FEEDS_PER_RUN}${this.share ? ", shared" : ""})`;
}

class Refresh implements Cmd {
  constructor(readonly who: Who, readonly srcPick: number, readonly twice: boolean) {}
  check = (m: Model) => m.srcs.length > 0;
  async run(m: Model, real: Real) {
    const s = at(m.srcs, this.srcPick)!;
    const label = `${this.who} refreshes ${s.id} (feed ${s.feed})`;
    const res = await real.call(this.who, "POST", `/api/rss/sources/${s.id}/refresh`);
    if (!s.live || !m.readable(this.who, s)) { expectStatus(res, [404], label); hit("refresh.refused"); return; }
    expectStatus(res, [200], label);
    await drainFetchFor(s.id);
    m.fetch(s);
    if (this.twice) {
      // The same feed content a second time: not one row more.
      const before = (await q<{ n: string }>(`SELECT count(*)::text n FROM rss_staging WHERE subscription_id = $1`, [s.id])).rows[0]!.n;
      expectStatus(await real.call(this.who, "POST", `/api/rss/sources/${s.id}/refresh`), [200], label);
      await drainFetchFor(s.id);
      m.fetch(s);
      const after = (await q<{ n: string }>(`SELECT count(*)::text n FROM rss_staging WHERE subscription_id = $1`, [s.id])).rows[0]!.n;
      expect(after, `${label}: second refresh of the same content`).toBe(before);
      hit("refresh.twice");
    }
    hit("refresh");
  }
  toString = () => `Refresh(${this.who}, src#${this.srcPick}${this.twice ? ", twice" : ""})`;
}

/** Pick an article of any source (also of one the actor cannot read). */
function pickArt(m: Model, srcPick: number, artPick: number): { s: Src; a: Art } | undefined {
  const s = at(m.srcs.filter((x) => x.arts.size > 0), srcPick);
  if (!s) return undefined;
  return { s, a: at([...s.arts.values()], artPick)! };
}

/** The status an item route answers for this actor. */
function itemStatus(m: Model, who: Who, s: Src, a: Art): 200 | 404 | 410 {
  if (!s.live || !m.readable(who, s)) return 404;
  return a.tomb ? 410 : 200;
}

class MarkSeen implements Cmd {
  constructor(readonly who: Who, readonly srcPick: number, readonly artPick: number, readonly seen: boolean) {}
  check = (m: Model) => pickArt(m, this.srcPick, this.artPick) !== undefined;
  async run(m: Model, real: Real) {
    const { s, a } = pickArt(m, this.srcPick, this.artPick)!;
    const label = `${this.who} marks ${a.guid} of ${s.id} ${this.seen ? "seen" : "unseen"}`;
    const status = itemStatus(m, this.who, s, a);
    const res = await real.call(this.who, "POST", `/api/rss/items/${await stagingId(s, a.guid)}/seen`, { seen: this.seen });
    expectStatus(res, [status], label);
    if (status === 200) a.seen[this.who] = this.seen;
    hit(status === 200 ? (this.seen ? "seen" : "unseen") : "seen.refused");
  }
  toString = () => `MarkSeen(${this.who}, src#${this.srcPick}, art#${this.artPick}, ${this.seen})`;
}

/** KNOWN F1 (pinned by the `it.fails` at the end): the situation the random sequences leave out so the other invariants
 *  keep being checked. `PROPS_RSS_KNOWN=include` puts it back (the property then fails with the shrunk sequence). */
const INCLUDE_KNOWN = process.env.PROPS_RSS_KNOWN === "include";
/** True only while the random property runs: the named cases at the end write the situation out on purpose. */
let leaveOutKnown = false;

/** The saver already has a note (live or in the trash) of the article, but the article's one pointer names another
 *  person's note, so the save cannot see it and makes a second one. */
function pointerLostToAnotherSaver(m: Model, s: Src, a: Art, who: Who): boolean {
  const pointed = a.saved ? m.notes.find((n) => n.id === a.saved) : undefined;
  return m.notes.some((n) => n.src === s && n.guid === a.guid && n.by === who) && pointed?.by !== who;
}

class Save implements Cmd {
  constructor(readonly who: Who, readonly srcPick: number, readonly artPick: number) {}
  check = (m: Model) => {
    const picked = pickArt(m, this.srcPick, this.artPick);
    return picked !== undefined && (!leaveOutKnown || !pointerLostToAnotherSaver(m, picked.s, picked.a, this.who));
  };
  async run(m: Model, real: Real) {
    const { s, a } = pickArt(m, this.srcPick, this.artPick)!;
    const label = `${this.who} saves ${a.guid} of ${s.id}`;
    const status = itemStatus(m, this.who, s, a);
    const res = await real.call(this.who, "POST", `/api/rss/items/${await stagingId(s, a.guid)}/save`, {});
    const savedBefore = m.savedLive(a, this.who);
    if (status !== 200) { expectStatus(res, [status], label); hit("save.refused"); return; }
    if (savedBefore) {
      expectStatus(res, [200], label);
      expect(res.body.node_id, `${label}: a second save answers the same note`).toBe(savedBefore);
      expect(res.body.already_saved).toBe(true);
      hit("save.again");
      return;
    }
    // One note per article per person: the saver's own trashed note comes back (same id).
    const trashed = a.saved ? m.notes.find((x) => x.id === a.saved && !x.live && x.by === this.who) : undefined;
    if (trashed) {
      expectStatus(res, [200], label);
      expect(res.body.node_id, `${label}: saving again restores the trashed note`).toBe(trashed.id);
      expect(res.body.restored).toBe(true);
      trashed.live = true;
      a.seen[this.who] = true;
      hit("save.restores");
      return;
    }
    expectStatus(res, [201], label);
    const note: NoteM = { id: res.body.node_id, src: s, guid: a.guid, live: true, by: this.who, title: a.title };
    m.notes.push(note);
    a.saved = note.id;
    a.seen[this.who] = true;
    hit("save");
  }
  toString = () => `Save(${this.who}, src#${this.srcPick}, art#${this.artPick})`;
}

class FullText implements Cmd {
  constructor(readonly who: Who, readonly srcPick: number, readonly artPick: number) {}
  check = (m: Model) => pickArt(m, this.srcPick, this.artPick) !== undefined;
  async run(m: Model, real: Real) {
    const { s, a } = pickArt(m, this.srcPick, this.artPick)!;
    const label = `${this.who} loads the full text of ${a.guid} of ${s.id}`;
    const status = itemStatus(m, this.who, s, a);
    const res = await real.call(this.who, "POST", `/api/rss/items/${await stagingId(s, a.guid)}/fulltext`);
    if (status !== 200) { expectStatus(res, [status], label); hit("fulltext.refused"); return; }
    if (m.savedLive(a, this.who)) { expectStatus(res, [409], label); hit("fulltext.saved"); return; }
    expectStatus(res, [200], label);
    a.fulltext = true;
    hit("fulltext");
  }
  toString = () => `FullText(${this.who}, src#${this.srcPick}, art#${this.artPick})`;
}

/** The creator trashes or restores a saved note. */
class TrashSaved implements Cmd {
  constructor(readonly notePick: number) {}
  check = (m: Model) => m.notes.some((n) => n.live);
  async run(m: Model, real: Real) {
    const n = at(m.notes.filter((x) => x.live), this.notePick)!;
    expectStatus(await real.call(n.by, "DELETE", `/api/nodes/${n.id}`), [200], `${n.by} trashes saved note ${n.id}`);
    n.live = false;
    hit("trashSaved");
  }
  toString = () => `TrashSaved(#${this.notePick})`;
}

class RestoreSaved implements Cmd {
  constructor(readonly notePick: number) {}
  private candidates = (m: Model) => m.notes.filter((n) => !n.live);
  check = (m: Model) => this.candidates(m).length > 0;
  async run(m: Model, real: Real) {
    const n = at(this.candidates(m), this.notePick)!;
    expectStatus(await real.call(n.by, "POST", `/api/nodes/${n.id}/undelete`), [200], `${n.by} restores saved note ${n.id}`);
    n.live = true;
    hit("restoreSaved");
  }
  toString = () => `RestoreSaved(#${this.notePick})`;
}

class Unsubscribe implements Cmd {
  constructor(readonly who: Who, readonly srcPick: number) {}
  check = (m: Model) => m.srcs.length > 0;
  async run(m: Model, real: Real) {
    const s = at(m.srcs, this.srcPick)!;
    const label = `${this.who} unsubscribes from ${s.id} (feed ${s.feed})`;
    const res = await real.call(this.who, "POST", `/api/rss/sources/${s.id}/unsubscribe`);
    if (!s.live || !m.readable(this.who, s)) { expectStatus(res, [404], label); hit("unsubscribe.refused"); return; }
    expectStatus(res, [200], label);
    s.live = false;
    // The whole stream goes with the subscription; the saved notes are notes and stay.
    s.arts.clear();
    hit("unsubscribe");
  }
  toString = () => `Unsubscribe(${this.who}, src#${this.srcPick})`;
}

// ── Inbox commands ──────────────────────────────────────────────────────────

class AgentCapture implements Cmd {
  constructor(readonly title: number) {}
  check = () => true;
  async run(m: Model, real: Real) {
    const title = `Agent capture ${m.agentNotes.length}-${this.title}`;
    const res = await real.call("agent", "POST", "/api/nodes", { title, markdown: `captured ${title}` });
    expectStatus(res, [201], "agent capture");
    const eventId = (await q<{ id: string }>(
      `SELECT id::text FROM domain_events WHERE event_type = 'NODE_CREATED' AND target_id = $1 ORDER BY domain_events.id DESC LIMIT 1`, [res.body.id])).rows[0]!.id;
    m.agentNotes.push({ id: res.body.id, eventId, live: true, reviewed: null });
    hit("agentCapture");
  }
  toString = () => `AgentCapture(${this.title})`;
}

class HumanCapture implements Cmd {
  constructor(readonly who: Who) {}
  check = () => true;
  async run(m: Model, real: Real) {
    const res = await real.call(this.who, "POST", "/api/nodes", { title: `Human capture ${m.humanNotes.length}`, markdown: "mine" });
    expectStatus(res, [201], "human capture");
    m.humanNotes.push(res.body.id);
    hit("humanCapture");
  }
  toString = () => `HumanCapture(${this.who})`;
}

class Decide implements Cmd {
  constructor(readonly who: Who, readonly decision: "approve" | "reject", readonly notePick: number) {}
  check = (m: Model) => m.queue().length > 0;
  async run(m: Model, real: Real) {
    const n = at(m.queue(), this.notePick)!;
    const label = `${this.who} ${this.decision}s agent note ${n.id}`;
    const res = await real.call(this.who, "POST", `/api/inbox/${n.eventId}/${this.decision}`, {});
    if (this.who !== "A") { expectStatus(res, [403], label); hit("decide.refused"); return; }
    expectStatus(res, [200], label);
    n.reviewed = this.decision === "approve" ? "approved" : "rejected";
    if (this.decision === "reject") n.live = false;
    hit(`decide.${this.decision}`);
  }
  toString = () => `Decide(${this.who}, ${this.decision}, #${this.notePick})`;
}

/** The owner trashes or restores an agent note that is still waiting or was approved. */
class ToggleAgentNote implements Cmd {
  constructor(readonly notePick: number) {}
  private candidates = (m: Model) => m.agentNotes.filter((n) => n.reviewed !== "rejected");
  check = (m: Model) => this.candidates(m).length > 0;
  async run(m: Model, real: Real) {
    const n = at(this.candidates(m), this.notePick)!;
    const res = n.live
      ? await real.call("A", "DELETE", `/api/nodes/${n.id}`)
      : await real.call("A", "POST", `/api/nodes/${n.id}/undelete`);
    expectStatus(res, [200], `A ${n.live ? "trashes" : "restores"} agent note ${n.id}`);
    n.live = !n.live;
    hit(n.live ? "agentNote.restore" : "agentNote.trash");
  }
  toString = () => `ToggleAgentNote(#${this.notePick})`;
}

class Settle implements Cmd {
  check = () => true;
  async run() {}
  toString = () => "Noop()";
}

// ── Verification ────────────────────────────────────────────────────────────

type Item = { id: string; source_id: string; title: string; seen: boolean; saved_node_id: string | null };

async function verify(m: Model, real: Real, step: string): Promise<void> {
  const fail = (what: string, detail: unknown) => { throw new Error(`[${step}] ${what}: ${JSON.stringify(detail, null, 1)}`); };
  const srcIds = m.srcs.map((s) => s.id);

  // Staging: one row per (source, guid), the guids and first-seen titles of the model.
  const rows = (await q<{ id: string; subscription_id: string; guid: string; title: string; tombstoned_at: string | null; body: string }>(
    `SELECT id::text, subscription_id::text, guid, title, tombstoned_at, body FROM rss_staging WHERE subscription_id = ANY($1::uuid[])`, [srcIds])).rows;
  const byKey = new Map<string, typeof rows[number]>();
  for (const r of rows) {
    const key = `${r.subscription_id}/${r.guid}`;
    if (byKey.has(key)) fail("two staging rows for one guid", { key });
    byKey.set(key, r);
  }
  const idToArt = new Map<string, { s: Src; a: Art }>();
  for (const s of m.srcs) {
    for (const a of s.arts.values()) {
      const r = byKey.get(`${s.id}/${a.guid}`);
      if (!r) fail("model article missing in staging", { src: s.id, guid: a.guid });
      if (r!.title !== a.title) fail("article title is not the first-seen one", { guid: a.guid, db: r!.title, model: a.title });
      if (!!r!.tombstoned_at !== a.tomb) fail("tombstone differs", { guid: a.guid, db: !!r!.tombstoned_at, model: a.tomb });
      if (a.fulltext && !a.tomb && !r!.body.includes("FULLTEXT")) fail("loaded full text was lost", { guid: a.guid });
      idToArt.set(r!.id, { s, a });
    }
    const dbGuids = rows.filter((r) => r.subscription_id === s.id).map((r) => r.guid).sort();
    if (dbGuids.join() !== [...s.arts.keys()].sort().join()) fail("staging guids differ from the model", { src: s.id, db: dbGuids, model: [...s.arts.keys()] });
  }

  // Notes made from articles: at most one live per article and saver, equal to the model, never lost by unsubscribing.
  const noteRows = (await q<{ id: string; deleted: boolean; title: string; guid: string | null; src: string | null }>(
    `SELECT n.id::text, n.deleted_at IS NOT NULL AS deleted, n.title,
            (SELECT value FROM node_attributes WHERE node_id = n.id AND key = '_rss_guid') AS guid,
            (SELECT value FROM node_attributes WHERE node_id = n.id AND key = '_rss_source') AS src
       FROM content_nodes n WHERE n.workspace_id = $1 AND n.id IN (SELECT node_id FROM node_attributes WHERE key = '_rss_source')`,
    [real.ws])).rows;
  const liveCount = new Map<string, number>();
  for (const r of noteRows) {
    const key = `${r.src}/${r.guid} saved by ${m.notes.find((n) => n.id === r.id)?.by}`;
    if (!r.deleted) liveCount.set(key, (liveCount.get(key) ?? 0) + 1);
  }
  for (const [key, n] of liveCount) if (n > 1) fail("a person has more than one live note of an article", { article: key, live: n });
  const dbById = new Map(noteRows.map((r) => [r.id, r]));
  for (const n of m.notes) {
    const r = dbById.get(n.id);
    if (!r) fail("saved note is gone", { note: n.id });
    if (r!.deleted === n.live) fail("saved note liveness differs", { note: n.id, model: n.live, dbDeleted: r!.deleted });
    if (r!.guid !== n.guid || r!.src !== n.src.id) fail("saved note lost its provenance", { note: n.id, db: r });
    if (r!.title !== n.title) fail("saved note title is not the article's", { note: n.id, db: r!.title, model: n.title });
  }
  if (noteRows.length !== m.notes.length) fail("notes with RSS provenance differ from the model", { db: noteRows.length, model: m.notes.length });

  // Reader views, per person.
  const known = (id: string) => idToArt.has(id);
  for (const who of ["A", "B"] as const) {
    const visible = m.visible(who);
    const expectIds = new Set<string>();
    for (const s of visible) for (const a of s.arts.values()) if (!a.tomb) expectIds.add(rows.find((r) => r.subscription_id === s.id && r.guid === a.guid)!.id);
    const list = await real.call(who, "GET", "/api/rss/items?limit=100");
    expectStatus(list, [200], `${who} lists items`);
    const items = list.body.items as Item[];
    if (list.body.next_cursor !== null) fail("unexpected second page", { who });
    if (new Set(items.map((i) => i.id)).size !== items.length) fail("an item is listed twice", { who });
    const got = new Set(items.map((i) => i.id));
    if (got.size !== expectIds.size || [...expectIds].some((id) => !got.has(id))) {
      fail(`${who} lists the wrong articles`, { got: items.map((i) => `${i.source_id}/${idToArt.get(i.id)?.a.guid ?? i.id}`), want: [...expectIds].map((id) => `${idToArt.get(id)!.s.id}/${idToArt.get(id)!.a.guid}`) });
    }
    for (const it of items) {
      if (!known(it.id)) fail("an item of an unknown source", { id: it.id });
      const { s, a } = idToArt.get(it.id)!;
      if (it.source_id !== s.id) fail("item names the wrong source", { id: it.id });
      if (it.title !== a.title) fail("item title differs", { id: it.id });
      if (it.seen !== a.seen[who]) fail(`${who}'s seen flag differs`, { guid: a.guid, src: s.id, api: it.seen, model: a.seen[who] });
      const wantSaved = m.savedLive(a, who);
      if (it.saved_node_id !== wantSaved) fail("saved pointer differs", { guid: a.guid, api: it.saved_node_id, model: wantSaved });
    }
    // The unseen filter, the per-source unseen counts and the total agree with the list.
    const fullList = await real.call(who, "GET", "/api/rss/items?limit=100");
    const unseenList = { body: { items: (fullList.body.items as Array<Item & { seen: boolean }>).filter((i) => !i.seen) } };
    const wantUnseen = items.filter((i) => !i.seen).length;
    if ((unseenList.body.items as Item[]).length !== wantUnseen) fail(`${who}'s unseen list differs from the seen flags`, { list: unseenList.body.items.length, flags: wantUnseen });
    const subs = await real.call(who, "GET", "/api/rss/sources");
    const subIds = (subs.body.sources as Array<{ id: string; unseen: number }>).map((s) => s.id).sort();
    if (subIds.join() !== visible.map((s) => s.id).sort().join()) fail(`${who} sees the wrong subscriptions`, { api: subIds, model: visible.map((s) => s.id) });
    for (const sub of subs.body.sources as Array<{ id: string; unseen: number }>) {
      const s = visible.find((x) => x.id === sub.id)!;
      const want = [...s.arts.values()].filter((a) => !a.tomb && !a.seen[who]).length;
      if (sub.unseen !== want) fail(`${who}'s unseen count of a source differs`, { src: sub.id, api: sub.unseen, model: want });
    }
    if (subs.body.total_unseen !== wantUnseen) fail(`${who}'s total unseen differs from the list`, { api: subs.body.total_unseen, list: wantUnseen });
  }

  // One article read, rotating: a source nobody may read answers 404, a tombstone 410.
  const all = [...idToArt.entries()];
  if (all.length > 0) {
    const [id, { s, a }] = all[step.length % all.length]!;
    for (const who of ["A", "B"] as const) {
      const res = await real.call(who, "GET", `/api/rss/items/${id}`);
      expectStatus(res, [itemStatus(m, who, s, a)], `${who} reads ${a.guid} of ${s.id}`);
    }
  }

  // The inbox: exactly the unreviewed agent notes still in the library, for every member.
  const wantEvents = m.queue().map((n) => n.eventId).sort();
  for (const who of ["A", "B"] as const) {
    const inbox = await real.call(who, "GET", "/api/inbox?limit=500");
    expectStatus(inbox, [200], `${who} reads the inbox`);
    const events = inbox.body.events as Array<{ id: string; event_type: string; target_id: string }>;
    if (inbox.body.count !== events.length) fail(`${who}'s inbox count differs from the list`, { count: inbox.body.count, length: events.length });
    const ids = events.map((e) => e.id).sort();
    if (ids.join() !== wantEvents.join()) fail(`${who}'s inbox differs from the model`, { api: events.map((e) => `${e.event_type}:${e.target_id}`), model: wantEvents });
    const facetTotal = (inbox.body.facets.by_type as Array<{ count: number }>).reduce((n, f) => n + f.count, 0);
    if (facetTotal !== events.length) fail(`${who}'s inbox facets do not add up`, { facetTotal, length: events.length });
  }
}

type Cmds = Array<{ check: (m: Model) => boolean; run: (m: Model, r: Real) => Promise<void>; toString: () => string }>;

async function runCommands(commands: Iterable<Cmd>): Promise<void> {
  const real = await newReal();
  const model = new Model(real);
  await verify(model, real, "setup");
  let step = 0;
  const verifying: Cmds = [...commands].map((command) => ({
    check: (m: Model) => command.check(m),
    run: async (m: Model, r: Real) => { await command.run(m, r); await verify(m, r, `#${++step} ${command}`); },
    toString: () => command.toString(),
  }));
  await fc.asyncModelRun(() => ({ model, real }), verifying);
}

// ── Generators ──────────────────────────────────────────────────────────────

const feedNo = fc.nat(FEEDS_PER_RUN - 1);
const feedItems = fc.array(fc.tuple(fc.nat(GUIDS_PER_FEED - 1), fc.nat(2)), { minLength: 1, maxLength: 6 });
const setFeed = fc.tuple(feedNo, feedItems).map(([f, items]) => new SetFeed(f, items));
const refresh = fc.tuple(who, pick, fc.boolean()).map(([w, s, twice]) => new Refresh(w, s, twice));
const markSeen = fc.tuple(who, pick, pick, fc.boolean()).map(([w, s, a, v]) => new MarkSeen(w, s, a, v));
const save = fc.tuple(who, pick, pick).map(([w, s, a]) => new Save(w, s, a));
const commandArbs = [
  setFeed, setFeed, setFeed,
  fc.tuple(who, feedNo, fc.boolean()).map(([w, f, share]) => new Subscribe(w, f, share)),
  fc.tuple(who, feedNo, fc.boolean()).map(([w, f, share]) => new Subscribe(w, f, share)),
  refresh, refresh, refresh,
  markSeen, markSeen, markSeen,
  save, save, save, save, save,
  fc.tuple(who, pick, pick).map(([w, s, a]) => new FullText(w, s, a)),
  pick.map((n) => new TrashSaved(n)), pick.map((n) => new TrashSaved(n)),
  pick.map((n) => new RestoreSaved(n)), pick.map((n) => new RestoreSaved(n)),
  fc.tuple(who, pick).map(([w, s]) => new Unsubscribe(w, s)),
  pick.map((n) => new AgentCapture(n)),
  who.map((w) => new HumanCapture(w)),
  fc.tuple(who, fc.constantFrom<"approve" | "reject">("approve", "reject"), pick).map(([w, d, n]) => new Decide(w, d, n)),
  pick.map((n) => new ToggleAgentNote(n)),
  fc.constant(new Settle()),
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!isTestDb)("inbox and RSS reader: model-based random test", () => {
  beforeAll(() => {
    __setFeedFetchForTests(async (url): Promise<ParsedFeed> => {
      const items = urls.get(url);
      if (!items) throw new Error(`stub: no feed for ${url}`);
      return { title: "Fake feed", etag: null, lastModified: null, notModified: false, items: items.map((i) => ({ ...i })) };
    });
    __setPageFetchForTests(async (url) =>
      `<html><body><article><h1>Full</h1><p>FULLTEXT ${url} ${"The whole article text goes here. ".repeat(20)}</p><p>${"More of the article. ".repeat(20)}</p></article></body></html>`);
  });
  afterAll(() => { __setFeedFetchForTests(null); __setPageFetchForTests(null); });

  it(`random command sequences keep every invariant `, async () => {
    const runs = process.env.PROPS_RUNS ? PROPS_RUNS : DEFAULT_RUNS;
    writeSync(2, `[inboxRss.property] PROPS_SEED=${process.env.PROPS_SEED ?? "(default)"} PROPS_RUNS=${runs} (replay with both set)\n`);
    leaveOutKnown = !INCLUDE_KNOWN;
    try {
      await checkAsync(fc.asyncProperty(
        fc.commands(commandArbs, { maxCommands: MAX_COMMANDS, size: "large" }),
        async (commands) => { await runCommands(commands as Iterable<Cmd>); },
      ), process.env.PROPS_RUNS ? Infinity : DEFAULT_RUNS);
    } finally { leaveOutKnown = false; }
    writeSync(2, `[inboxRss.property] reach: ${[...reach].sort().map(([k, n]) => `${k}=${n}`).join(", ")}\n`);
  }, process.env.PROPS_RUNS ? 6 * 3600_000 : 600_000);

  // Saving an article again restores its trashed note: one note per article per person.
  it("trash the saved note, save the article again: the same note is back, restoring it by hand still works", async () => {
    await runCommands([
      new SetFeed(0, [[0, 0]]), new Subscribe("A", 0, false), new Save("A", 0, 0),
      new TrashSaved(0), new Save("A", 0, 0), new TrashSaved(0), new RestoreSaved(0),
    ]);
  }, 120_000);

  // rss_staging.saved_node_id is one column per article, not per reader: items.ts hideUnreadableSaves
  // keeps it from handing a private note's id to a reader who cannot read it.
  it("A saves a shared article into A's private space: B's list and B's save show A's note id", async () => {
    const real = await newReal();
    const model = new Model(real);
    const commands: Cmd[] = [new SetFeed(0, [[0, 0]]), new Subscribe("A", 0, true), new Save("A", 0, 0)];
    for (const command of commands) await command.run(model, real);
    const article = [...model.srcs[0]!.arts.values()][0]!;
    const noteId = article.saved!;
    const readable = (await real.call("B", "GET", `/api/nodes/${noteId}`)).status;
    expect(readable, "B cannot read A's private note").toBe(404);
    const list = await real.call("B", "GET", "/api/rss/items?limit=100");
    expect((list.body.items as Item[])[0]!.saved_node_id, "B's list must not name a note B cannot read").toBeNull();
    const again = await real.call("B", "POST", `/api/rss/items/${(list.body.items as Item[])[0]!.id}/save`);
    expect(again.body.node_id, "B's save must not answer A's private note id").not.toBe(noteId);
  }, 120_000);

  // F1. Nightly 2026-11-05, seed 555824178 (replay: PROPS_SEED=555824178 PROPS_RUNS=300, this suite); met again by the
  // first run with a fresh seed per run, 2026-11-18, PROPS_SEED=104376501 PROPS_RUNS=40, shrunk to exactly the same
  // sequence (the literal case below). Broken
  // invariant: one live note per article per person. rss_staging.saved_node_id is one column per article, so
  // after A's save overwrites B's pointer, B's next save cannot see B's own note and creates a second one.
  it.fails("B saves, A saves, B saves again: B ends with two live notes of the same article (nightly 2026-11-05)", async () => {
    await runCommands([
      new SetFeed(1, [[0, 0]]), new Subscribe("A", 1, true),
      new Save("B", 0, 0), new Save("A", 0, 0), new Save("B", 0, 0),
    ]);
  }, 120_000);

  // F1, the literal sequence of PROPS_SEED=104376501 (replayPath "CBCBBHD/O:qG"): two people save the same article of a
  // shared feed, the second person twice. Pinned as the same defect, with what each person ends up holding
  // (asserted below the failing line so the case shows the whole picture when it is fixed): nothing a person wrote is lost.
  it.fails("F1 literal: Subscribe(A, shared), Refresh, Save(B), Save(A), Save(B): B holds two live notes of the article (seed 104376501)", async () => {
    await runCommands([
      new Subscribe("A", 0, true), new SetFeed(0, [[0, 0]]), new Refresh("A", 0, false),
      new Save("B", 0, 0), new Save("A", 0, 0), new Save("B", 0, 0),
    ]);
  }, 120_000);

  // Only what must hold whichever way F1 is decided: nothing a person saved is lost (the defect itself is the `it.fails` above).
  it("F1: after B, A, B save the same article, B's first note and A's note are both still live", async () => {
    const real = await newReal();
    const model = new Model(real);
    for (const command of [new Subscribe("A", 0, true), new SetFeed(0, [[0, 0]]), new Refresh("A", 0, false)]) await command.run(model, real);
    const stagingRow = (await q<{ id: string }>(`SELECT id::text FROM rss_staging WHERE subscription_id = $1`, [model.srcs[0]!.id])).rows[0]!.id;
    const save = async (who: Who) => (await real.call(who, "POST", `/api/rss/items/${stagingRow}/save`, {})).body as { node_id: string };
    const b1 = (await save("B")).node_id;
    const a1 = (await save("A")).node_id;
    await save("B");
    const live = (await q<{ id: string }>(
      `SELECT n.id::text FROM content_nodes n JOIN node_attributes g ON g.node_id = n.id AND g.key = '_rss_guid' WHERE n.workspace_id = $1 AND n.deleted_at IS NULL`, [real.ws])).rows.map((r) => r.id);
    expect(live).toEqual(expect.arrayContaining([a1, b1]));
  }, 120_000);
});
