// RSS 「訂閱放在」(modules/rss/sourceSpace.ts): the workspace setting
// `rss_source_space` decides which space new subscriptions go to, and changing
// it (owner only, one transaction) moves the owner's existing subscriptions.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
import { drainOutbox, registerOutboxEffect } from "../services/outbox.js";
import rssRouter from "../modules/rss/routes.js";
import { __setFeedFetchForTests, rssFetchEffect, type ParsedFeed } from "../modules/rss/fetch.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import type { ActorCtx } from "../types.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(DB) || /onden_test(\?|$)/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/rss", rssRouter);
registerOutboxEffect(rssFetchEffect);

const J = { "content-type": "application/json" };
const call = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: J, body: body === undefined ? undefined : JSON.stringify(body) });

describe.skipIf(!isTestDb)("rss: where subscriptions live (rss_source_space)", () => {
  const stamp = Date.now();
  let owner: ActorCtx;
  let member: ActorCtx;   // edits the shared space
  let reader: ActorCtx;   // only views it
  let team = "";          // a shared space: owner + member edit, reader view
  let otherTeam = "";     // a shared space the member is not in
  let seq = 0;

  const feedOf = (title: string): ParsedFeed => ({
    title, etag: null, lastModified: null, notModified: false,
    items: [{ guid: `g-${title}`, title: `Article ${title}`, url: `https://feed.test/${title}`, publishedAt: new Date().toISOString(), contentHtml: "<p>Body</p>" }],
  });
  const feeds = new Map<string, ParsedFeed>();

  const subscribeTo = async (as: ActorCtx, url: string) => {
    feeds.set(url, feedOf(`f${++seq}`));
    currentActor = as;
    const res = await call("POST", "/api/rss/subscribe", { url });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const subscribe = (as: ActorCtx) => subscribeTo(as, `https://feed.test/src-${stamp}-${seq + 1}.xml`);
  const preview = async (spaceId: string) => {
    currentActor = owner;
    return (await (await call("GET", `/api/rss/source-space/preview?space_id=${spaceId}`)).json()) as { movable: number; skipped_duplicate: number };
  };
  // A subscription's space (rss_subscriptions) or a note's (content_nodes).
  const spaceOf = async (id: string) =>
    (await q<{ s: string }>(
      `SELECT space_id::text AS s FROM rss_subscriptions WHERE id = $1
       UNION ALL SELECT space_id::text FROM content_nodes WHERE id = $1`, [id])).rows[0]!.s;
  const personalOf = async (a: ActorCtx) =>
    (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND kind = 'personal' AND owner_actor_id::text = $2`, [WS, a.id])).rows[0]!.id;
  const setting = async (as: ActorCtx, spaceId: string) => {
    currentActor = as;
    return call("PUT", "/api/rss/source-space", { space_id: spaceId });
  };
  const drainFetch = async (sourceId: string) => {
    for (let i = 0; i < 100; i++) {
      const row = (await q<{ id: string; status: string }>(
        `SELECT id::text, status FROM outbox WHERE dedup_key = $1 ORDER BY outbox.id DESC LIMIT 1`, [`rss_fetch:${sourceId}`])).rows[0]!;
      if (row.status === "done") return;
      await drainOutbox({ id: row.id });
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("rss_fetch never drained");
  };

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('RSS space', $1) RETURNING id::text`, [`rss-space-${randomUUID()}`])).rows[0]!.id;
    await setModulesOn(WS, null);
    owner = await persistActor(WS, { id: "o", name: "Owner", role: "admin", type: "human" });
    member = await persistActor(WS, { id: "m", name: "Member", role: "editor", type: "human" });
    reader = await persistActor(WS, { id: "r", name: "Reader", role: "editor", type: "human" });
    team = await makeSpace(WS, `Team ${stamp}`, [{ id: owner.id, permission: "edit" }, { id: member.id, permission: "edit" }, { id: reader.id, permission: "view" }]);
    otherTeam = await makeSpace(WS, `Other ${stamp}`, [{ id: owner.id, permission: "edit" }]);
    __setFeedFetchForTests(async (url) => {
      const feed = feeds.get(url);
      if (!feed) throw new Error(`stub: no feed for ${url}`);
      return feed;
    });
  });
  afterAll(() => { __setFeedFetchForTests(null); });

  it("with the setting empty a subscription goes to the subscriber's own space", async () => {
    expect((await setting(owner, "")).status).toBe(200);
    const id = await subscribe(member);
    expect(await spaceOf(id)).toBe(await personalOf(member));
  });

  it("with a shared space set, new subscriptions (subscribe and OPML) go there", async () => {
    expect((await setting(owner, team)).status).toBe(200);
    expect(await spaceOf(await subscribe(owner))).toBe(team);
    const memberSource = await subscribe(member);
    expect(await spaceOf(memberSource)).toBe(team);
    // The member's colleagues see it through the space (read policy), and OPML too.
    currentActor = owner;
    const list = (await (await call("GET", "/api/rss/sources")).json()) as { sources: Array<{ id: string }> };
    expect(list.sources.map((s) => s.id)).toContain(memberSource);
    const opml = `<?xml version="1.0"?><opml version="2.0"><body><outline type="rss" text="Imp" xmlUrl="https://feed.test/opml-${stamp}.xml"/></body></opml>`;
    currentActor = member;
    const res = await call("POST", "/api/rss/opml", { opml });
    expect(res.status).toBe(200);
    const imported = (await q<{ s: string }>(
      `SELECT space_id::text AS s FROM rss_subscriptions WHERE workspace_id = $1 AND url = $2`,
      [WS, `https://feed.test/opml-${stamp}.xml`])).rows;
    expect(imported.map((r) => r.s)).toEqual([team]);
  });

  it("a subscriber who cannot write the space gets their own space", async () => {
    expect((await setting(owner, team)).status).toBe(200);
    const viewOnly = await subscribe(reader);
    expect(await spaceOf(viewOnly)).toBe(await personalOf(reader));
    expect((await setting(owner, otherTeam)).status).toBe(200);
    const notIn = await subscribe(member);
    expect(await spaceOf(notIn)).toBe(await personalOf(member));
  });

  it("changing the setting moves the owner's subscriptions and the old space's, never a member's private ones, never saved articles", async () => {
    expect((await setting(owner, "")).status).toBe(200);
    const ownerSource = await subscribe(owner);
    const memberPrivate = await subscribe(member);
    await drainFetch(ownerSource);
    currentActor = owner;
    const items = (await (await call("GET", `/api/rss/items?source=${ownerSource}`)).json()) as { items: Array<{ id: string }> };
    const saved = await call("POST", `/api/rss/items/${items.items[0]!.id}/save`);
    expect(saved.status).toBe(201);
    const articleId = ((await saved.json()) as { node_id: string }).node_id;
    const ownerPersonal = await personalOf(owner);
    expect(await spaceOf(articleId)).toBe(ownerPersonal);

    currentActor = owner;
    const plan = await preview(team);
    expect(plan.movable).toBeGreaterThanOrEqual(1);
    const res = await setting(owner, team);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { moved: number }).moved).toBe(plan.movable);

    expect(await spaceOf(ownerSource)).toBe(team);
    expect(await spaceOf(memberPrivate)).toBe(await personalOf(member));
    expect(await spaceOf(articleId)).toBe(ownerPersonal);

    // Moving on from `team`: what the owner made there follows, a member's does not.
    const memberInTeam = await subscribe(member);
    expect(await spaceOf(memberInTeam)).toBe(team);
    expect((await setting(owner, otherTeam)).status).toBe(200);
    expect(await spaceOf(ownerSource)).toBe(otherTeam);
    expect(await spaceOf(memberInTeam)).toBe(team);
    expect(await spaceOf(memberPrivate)).toBe(await personalOf(member));
  });

  it("a member's subscription in the old shared space stays, and neither the preview nor the move counts it", async () => {
    expect((await setting(owner, "")).status).toBe(200);
    expect((await setting(owner, team)).status).toBe(200);
    // Earlier tests leave the owner's own subscriptions in `team` and in their
    // personal space; those move too. Count them first so only the difference
    // this test makes is asserted, whatever order the tests ran in.
    const before = (await preview(otherTeam)).movable;
    const ownerInTeam = await subscribe(owner);
    const memberInTeam = await subscribe(member);
    expect(await spaceOf(ownerInTeam)).toBe(team);
    expect(await spaceOf(memberInTeam)).toBe(team);

    // The owner's own new subscription is the only addition; the member's is not counted.
    const plan = await preview(otherTeam);
    expect(plan.movable).toBe(before + 1);
    const res = await setting(owner, otherTeam);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { moved: number }).moved).toBe(plan.movable);
    expect(await spaceOf(ownerInTeam)).toBe(otherTeam);
    expect(await spaceOf(memberInTeam)).toBe(team);
    // The member can still see their subscription (they are not in otherTeam).
    currentActor = member;
    const list = (await (await call("GET", "/api/rss/sources")).json()) as { sources: Array<{ id: string }> };
    expect(list.sources.map((x) => x.id)).toContain(memberInTeam);
  });

  it("a subscription whose feed the target space already follows is skipped, not duplicated, and what was saved from it stays", async () => {
    expect((await setting(owner, "")).status).toBe(200);
    expect((await setting(owner, team)).status).toBe(200);
    const url = `https://feed.test/dup-${stamp}-${++seq}.xml`;
    const inTeam = await subscribeTo(member, url);          // the team already follows it
    expect(await spaceOf(inTeam)).toBe(team);
    expect((await setting(owner, "")).status).toBe(200);
    const mine = await subscribeTo(owner, url);             // the owner's own copy
    const other = await subscribe(owner);                   // a different feed: moves normally
    const ownerPersonal = await personalOf(owner);
    expect(await spaceOf(mine)).toBe(ownerPersonal);
    await drainFetch(mine);
    currentActor = owner;
    const stream = (await (await call("GET", `/api/rss/items?source=${mine}`)).json()) as { items: Array<{ id: string }> };
    const childId = ((await (await call("POST", `/api/rss/items/${stream.items[0]!.id}/save`)).json()) as { node_id: string }).node_id;

    const plan = await preview(team);
    expect(plan.skipped_duplicate).toBeGreaterThanOrEqual(1);
    const res = await setting(owner, team);
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { moved: number; skipped_duplicate: number };
    expect(answer).toMatchObject({ moved: plan.movable, skipped_duplicate: plan.skipped_duplicate });

    expect(await spaceOf(mine)).toBe(ownerPersonal);        // skipped: still the owner's own
    expect(await spaceOf(childId)).toBe(ownerPersonal);     // nothing under it was lost or moved
    expect(await spaceOf(inTeam)).toBe(team);
    expect(await spaceOf(other)).toBe(team);
    // The team now follows each feed once.
    const urls = (await q<{ value: string }>(
      `SELECT url AS value FROM rss_subscriptions WHERE workspace_id = $1 AND space_id = $2`, [WS, team])).rows.map((r) => r.value);
    expect(urls.filter((u) => u === url)).toHaveLength(1);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("a subscription's stream and its saved articles follow different rules, and switching back to empty moves nothing back", async () => {
    expect((await setting(owner, "")).status).toBe(200);
    const source = await subscribe(owner);
    await drainFetch(source);
    currentActor = owner;
    const stream = (await (await call("GET", `/api/rss/items?source=${source}`)).json()) as { items: Array<{ id: string }> };
    const articleId = ((await (await call("POST", `/api/rss/items/${stream.items[0]!.id}/save`)).json()) as { node_id: string }).node_id;
    const ownerPersonal = await personalOf(owner);
    expect(await spaceOf(articleId)).toBe(ownerPersonal);

    expect((await setting(owner, team)).status).toBe(200);
    expect(await spaceOf(source)).toBe(team);
    expect(await spaceOf(articleId)).toBe(ownerPersonal); // a saved article is a note: it stays
    // What is still in the stream is read through the subscription: the team sees it now.
    currentActor = member;
    const seen = (await (await call("GET", `/api/rss/sources`)).json()) as { sources: Array<{ id: string }> };
    expect(seen.sources.map((x) => x.id)).toContain(source);

    // Choosing the empty setting changes where new ones go, not where these sit.
    const back = await setting(owner, "");
    expect(back.status).toBe(200);
    expect(((await back.json()) as { moved: number }).moved).toBe(0);
    expect(await spaceOf(source)).toBe(team);
    expect(await spaceOf(articleId)).toBe(ownerPersonal);
  });

  it("the setting and the moves are one transaction: a refused target changes nothing", async () => {
    expect((await setting(owner, "")).status).toBe(200);
    const mine = await subscribe(owner);
    const res = await setting(owner, randomUUID());
    expect(res.status).toBe(422);
    expect(await spaceOf(mine)).toBe(await personalOf(owner));
    const stored = await q(`SELECT 1 FROM node_attributes WHERE workspace_id = $1 AND key = 'rss_source_space' AND value <> ''`, [WS]);
    expect(stored.rows.length).toBe(0);
    // Another member's personal space is not a valid target either.
    expect((await setting(owner, await personalOf(member))).status).toBe(422);
  });

  it("a non-owner cannot change the setting or preview the move", async () => {
    const storedSetting = async () => (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE workspace_id = $1 AND key = 'rss_source_space'`, [WS])).rows.map((r) => r.value);
    // Whatever an earlier test (order is shuffled) left stored stays as it was.
    const before = await storedSetting();
    for (const who of [member, reader]) {
      expect((await setting(who, team)).status).toBe(403);
      currentActor = who;
      expect((await call("GET", `/api/rss/source-space/preview?space_id=${team}`)).status).toBe(403);
    }
    expect(await storedSetting()).toEqual(before);
  });
});
