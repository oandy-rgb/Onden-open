// What Onden makes by itself is made with an id computed from what it is for (migration 201, services/derivedIds.ts), so that two
// creators end with one row: the capture and skills tags, the site settings tag and note and the system space, the next occurrence
// of a recurring task, and the articles of a feed.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { derivedIdName } from "@onden/markdown";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import { mountModules } from "../modules/index.js";
import { tasksModule } from "../modules/tasks/index.js";
import { drainDueTasks } from "../modules/tasks/scheduler.js";
import { ensureInboxTag } from "../modules/capture/inboxTag.js";
import { __setFeedFetchForTests, performRssFetch } from "../modules/rss/fetch.js";
import { derivedId, newIdFor } from "../services/derivedIds.js";
import { ensureModuleTag } from "../services/workspaceModules.js";
import { findConfigNodeId, patchSiteConfig } from "../services/siteConfig.js";
import { mutate } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { localDayId } from "../localDay.js";
import { successorTaskId } from "../services/tasksStore.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

describe.skipIf(!isTestDatabase())("things made by themselves get an id that can be computed", () => {
  const tag = randomUUID().slice(0, 8);
  let owner!: ActorCtx;
  let actor: ActorCtx | null = null;
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/nodes", nodesRouter);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const day = (offset: number) => {
    const d = new Date(`${localDayId()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const rows = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows.map((r) => r.id);

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Derived creation', $1) RETURNING id::text`, [`derived-creation-${tag}`])).rows[0]!.id;
    owner = await persistActor(WS, { id: "", name: `Owner ${tag}`, role: "admin", type: "human" });
    await setModulesOn(WS, null);
    mountModules(app, [tasksModule]);
    actor = owner;
  }, 30_000);
  afterAll(async () => { __setFeedFetchForTests(null); await pool.end(); });

  it("the capture tag: two creators at once end with one row, under the derived id; asking again returns it", async () => {
    const [a, b] = await Promise.all([ensureInboxTag(owner, WS), ensureInboxTag(owner, WS)]);
    expect(a).toBe(b);
    expect(a).toBe(derivedId(derivedIdName.moduleTag(WS, "capture")));
    expect(await rows(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND tag_schema->>'module' = 'capture'`, [WS])).toEqual([a]);
    expect(await ensureInboxTag(owner, WS)).toBe(a);
  });

  it("the skills tag made by turning the module on has the derived id too", async () => {
    const id = await withEventTransaction(WS, () => ensureModuleTag(owner, WS, "skills"));
    expect(id).toBe(derivedId(derivedIdName.moduleTag(WS, "skills")));
  });

  it("the site settings tag, note and system space: one of each, under the derived ids, however often the settings are written", async () => {
    const write = (brand: string) => mutate({
      actor: owner, workspaceId: WS, authority: { kind: "principal_admin" },
      event: { type: "SITE_CONFIG_UPDATED", targetType: "workspace", targetId: WS, payload: { keys: ["brand"] } },
      apply: async () => { await patchSiteConfig(WS, { brand }, owner); },
    });
    await write("One");
    await write("Two");
    expect(await findConfigNodeId(WS)).toBe(derivedId(derivedIdName.siteConfigNote(WS)));
    expect(await rows(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND reserved_key = 'workspace-config'`, [WS])).toEqual([derivedId(derivedIdName.reservedTag(WS, "workspace-config"))]);
    expect(await rows(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND slug = '_workspace_config'`, [WS])).toHaveLength(1);
    expect(await rows(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND kind = 'system'`, [WS])).toEqual([derivedId(derivedIdName.systemSpace(WS))]);
  });

  it("when the derived id already belongs to another row, a new row gets a random id instead of failing", async () => {
    const name = derivedIdName.moduleTag(WS, `probe-${tag}`);
    expect(await newIdFor("content_nodes", name)).toBe(derivedId(name));
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, $2, 'manual', 'content', 'Somebody''s note', $3, '')`, [derivedId(name), WS, `taken-${tag}`]);
    const other = await newIdFor("content_nodes", name);
    expect(other).not.toBe(derivedId(name));
    expect(other).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("an article of a feed has the id its feed and guid give it, however often or wherever it is fetched", async () => {
    const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    const sub = randomUUID();
    await seedQ(`INSERT INTO rss_subscriptions (id, workspace_id, space_id, title, url) VALUES ($1, $2, $3, 'Probe', $4)`, [sub, WS, space, `https://feed.test/${tag}.xml`]);
    const item = (n: number) => ({ guid: `guid-${tag}-${n}`, title: `Article ${n}`, url: `https://feed.test/${tag}/${n}`, publishedAt: new Date(Date.now() - n * 3600_000).toISOString(), contentHtml: `<p>${n}</p>` });
    __setFeedFetchForTests(async () => ({ title: "Probe", etag: null, lastModified: null, notModified: false, items: [item(1), item(2)] }));
    expect(await performRssFetch({ workspaceId: WS, subscriptionId: sub })).toMatchObject({ created: 2 });
    const first = await rows(`SELECT id::text FROM rss_staging WHERE subscription_id = $1 ORDER BY guid`, [sub]);
    expect(first).toEqual([1, 2].map((n) => derivedId(derivedIdName.rssArticle(sub, `guid-${tag}-${n}`))));
    expect(await performRssFetch({ workspaceId: WS, subscriptionId: sub })).toMatchObject({ created: 0, skipped: 2 });
    // another node fetching the same article (here: the row is gone and fetched again) makes the same row
    await seedQ(`DELETE FROM rss_staging WHERE subscription_id = $1`, [sub]);
    await performRssFetch({ workspaceId: WS, subscriptionId: sub });
    expect(await rows(`SELECT id::text FROM rss_staging WHERE subscription_id = $1 ORDER BY guid`, [sub])).toEqual(first);
  });

  describe("the next occurrence of a recurring task", () => {
    const task = async (body: Record<string, unknown>): Promise<{ id: string }> => {
      const res = await send("POST", "/api/tasks", { id: randomUUID(), ...body });
      expect(res.status, await res.clone().text()).toBe(201);
      return res.json() as Promise<{ id: string }>;
    };
    const titled = async (title: string) => (await rows(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2`, [WS, title])).sort();

    it("made by completing one: the id comes from the completed occurrence, and completing it again makes no second", async () => {
      const first = await task({ title: `Water ${tag}`, when_date: day(0), recur: "1d" });
      const done = await send("PATCH", `/api/tasks/${first.id}`, { status: "done" });
      expect(done.status).toBe(200);
      const successor = derivedId(derivedIdName.taskSuccessor(first.id));
      expect(await titled(`Water ${tag}`)).toEqual([first.id, successor].sort());
      expect(await successorTaskId(first.id)).toBeNull(); // it exists: not made twice, here or by another node
      await send("PATCH", `/api/tasks/${first.id}`, { status: "todo" });
      await send("PATCH", `/api/tasks/${first.id}`, { status: "done" });
      expect(await titled(`Water ${tag}`)).toHaveLength(2);
    });

    it("another node already made it: completing here makes nothing new, and the completion still succeeds", async () => {
      const first = await task({ title: `Walk ${tag}`, when_date: day(0), recur: "1d" });
      // what a merge from another node brings: the successor, under the derived id, already here
      await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, hidden) VALUES ($1, $2, 'manual', 'content', $3, $4, '', true)`,
        [derivedId(derivedIdName.taskSuccessor(first.id)), WS, `Walk ${tag}`, `walk-${tag}-next`]);
      expect((await send("PATCH", `/api/tasks/${first.id}`, { status: "done" })).status).toBe(200);
      expect(await titled(`Walk ${tag}`)).toHaveLength(2);
    });

    it("made by the scheduler for a missed occurrence: the same id, and it is made once", async () => {
      const missed = await task({ title: `Sweep ${tag}`, when_date: day(-3), recur: "1d" });
      await drainDueTasks({ today: localDayId() });
      await drainDueTasks({ today: localDayId() });
      const successor = derivedId(derivedIdName.taskSuccessor(missed.id));
      expect(await titled(`Sweep ${tag}`)).toEqual([missed.id, successor].sort());
    });
  });
});
