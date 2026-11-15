// Three publishing rules the owner decided on 2026-11-14:
//  1. taken-down content does not come back by itself — a note that left the site (「不發布」, trashed, its space
//     switched off) returns only with the NEXT publish (modules/website/publishing/takenDown.ts);
//  2. 「不發布」 with 「一起不發布」 marks a note and its live subtree in one action, one undo;
//  3. the site is the workspace owner's: a member's personal space is never on it.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import publishRouter from "../modules/website/routes.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { recordAttributeChange } from "../services/attributeChange.js";
import { trashNode, undeleteNode } from "../services/nodeTrash.js";
import { updateSpace, SpaceMoveError } from "../services/spaces.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { publishedNodeIds } from "../modules/website/publishing/publishedSet.js";
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import { noteSiteState } from "../modules/website/publishing/noteSiteState.js";
import type { PublishPreview } from "@onden/contract";
import type { ActorCtx } from "../types.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { postVia, publishWithPreview } from "./helpers/publishWithPreview.js";
import { seedQ } from "./helpers/seedQ.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api", publishRouter);
const post = postVia(app);
const preview = async () => (await (await post("/api/publish/preview", { title: "Site" })).json()) as PublishPreview;
const publish = async () => { expect((await publishWithPreview(post, { title: "Site" })).status).toBe(201); };
const servedText = async (id: string) =>
  ((await loadServedSite(WS)).payload.nodes as Array<{ id: string; markdown: string }>).find((n) => n.id === id)?.markdown ?? null;

describe.skipIf(!isTestDb)("publishing owner decisions 2026-11-14 (DB)", () => {
  let owner: ActorCtx, member: ActorCtx;
  let site = "";
  beforeAll(() => { registerShippedModules(); });
  afterAll(() => { currentActor = null; });

  async function setup() {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Owner decisions', $1) RETURNING id::text`, [`od-${randomUUID()}`])).rows[0]!.id;
    owner = await persistActor(WS, { id: "o", name: "Owner", role: "admin", type: "human" });
    member = await persistActor(WS, { id: "m", name: "Member", role: "editor", type: "human" });
    site = await makeSpace(WS, `網站 ${randomUUID()}`, [{ id: owner.id, role: "manager" }, { id: member.id, role: "editor" }], { publish: true, external_ai: false, backup: true });
    await setModulesOn(WS, null); // the website module is on: its hooks record what a change takes off the site
    currentActor = owner;
  }
  async function note(title: string, markdown: string, opts: { parent?: string; space?: string } = {}): Promise<string> {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, space_id)
       VALUES ($1,'manual','content',$2,$3,$4,$5,$6) RETURNING id::text`,
      [WS, title, randomUUID().slice(0, 8), markdown, opts.parent ?? null, opts.space ?? site])).rows[0]!.id;
    return id;
  }
  const keepOff = (id: string) => setNodeAttribute({ workspaceId: WS, actor: owner, nodeId: id, attribute: { key: "_published", value: "false", value_type: "text" } });
  const putBack = (id: string) => recordAttributeChange({
    workspaceId: WS, nodeId: id, key: "_published", actor: owner, next: null, rule: "always",
    authority: { kind: "node", nodeId: id, op: "delete_attribute" }, uiContext: "node.attribute.delete",
  });
  const rewrite = (id: string, markdown: string) => seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [id, markdown]);

  describe("1. taken-down content waits for the next publish", () => {
    it("「放回網站」: the old text is not served again; the preview lists the note as coming back; the next publish brings the new text", async () => {
      await setup();
      const a = await note("A", "old text of A");
      const stays = await note("Stays", "stays");
      await publish();
      expect(await servedText(a)).toBe("old text of A");

      await keepOff(a);
      expect(await servedText(a)).toBeNull();
      await rewrite(a, "new text of A");
      await putBack(a);
      expect(await publishedNodeIds(WS)).toContain(a); // it qualifies again…
      expect(await servedText(a)).toBeNull(); // …but is not served from the old snapshot
      expect(await servedText(stays)).toBe("stays");
      expect(await noteSiteState(WS, a, owner)).toBe("not_on_site");

      const p = await preview();
      expect(p.diff.returning.map((n) => n.id)).toEqual([a]);
      expect(p.diff.changed.map((n) => n.id)).not.toContain(a);

      await publish();
      expect(await servedText(a)).toBe("new text of A");
      expect((await preview()).diff.returning).toEqual([]);
    });

    it("restoring a deleted note: the old text is not served until the next publish", async () => {
      await setup();
      const a = await note("A", "old text of A");
      await publish();
      await trashNode(owner, WS, a);
      expect(await servedText(a)).toBeNull();
      await rewrite(a, "edited while deleted");
      await undeleteNode(owner, WS, a);
      expect(await servedText(a)).toBeNull();
      expect((await preview()).diff.returning.map((n) => n.id)).toEqual([a]);
      await publish();
      expect(await servedText(a)).toBe("edited while deleted");
    });

    it("switching a space's 發布到網站 off and on again: its notes wait for the next publish", async () => {
      await setup();
      const a = await note("A", "old text of A");
      await publish();
      await updateSpace(owner, WS, site, { capabilities: { publish: false } });
      expect(await servedText(a)).toBeNull();
      await rewrite(a, "new text of A");
      await updateSpace(owner, WS, site, { capabilities: { publish: true } });
      expect(await servedText(a)).toBeNull();
      expect((await preview()).diff.returning.map((n) => n.id)).toEqual([a]);
      await publish();
      expect(await servedText(a)).toBe("new text of A");
    });

    it("a note never taken down is still served as the snapshot froze it, and a new note waits as before", async () => {
      await setup();
      const a = await note("A", "frozen");
      await publish();
      await rewrite(a, "edited after publish");
      const fresh = await note("Fresh", "new note");
      expect(await servedText(a)).toBe("frozen");
      expect(await servedText(fresh)).toBeNull();
    });
  });

  describe("2. 「一起不發布」", () => {
    it("marks the note and every live note under it in one action; one undo (cascade) puts them all back", async () => {
      await setup();
      const root = await note("Root", "root");
      const kid = await note("Kid", "kid", { parent: root });
      const already = await note("Already off", "off", { parent: root });
      const grand = await note("Grand", "grand", { parent: kid });
      const trashed = await note("Trashed", "gone", { parent: root });
      await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [trashed]);
      await keepOff(already);
      const aloneAbove = await note("Sibling", "sibling");

      const res = await post("/api/publish/keep-off-subtree", { noteId: root });
      expect(res.status).toBe(200);
      const { marked, event_id: eventId } = (await res.json()) as { marked: number; event_id: string };
      expect(marked).toBe(3); // root, kid, grand — not the one already off, not the trashed one
      const flags = async () => Object.fromEntries((await q<{ node_id: string; value: string }>(
        `SELECT node_id::text, value FROM node_attributes WHERE workspace_id = $1 AND key = '_published'`, [WS])).rows.map((r) => [r.node_id, r.value]));
      expect(await flags()).toEqual({ [root]: "false", [kid]: "false", [grand]: "false", [already]: "false" });
      expect(await publishedNodeIds(WS)).toEqual(new Set([aloneAbove]));

      const caused = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1 AND triggered_by_event_id = $2`, [WS, eventId])).rows[0]!.n;
      expect(caused).toBe("2");
      const undone = await restoreEvent(eventId, { actor: owner, workspaceId: WS, cascade: true });
      expect("ok" in undone ? undone.ok : true).toBeTruthy();
      expect(await flags()).toEqual({ [already]: "false" });
    });

    it("「只有這則」 (the ordinary write) leaves the notes under it on the site, with no parent", async () => {
      await setup();
      const root = await note("Root", "root");
      const kid = await note("Kid", "kid", { parent: root });
      await keepOff(root);
      expect(await publishedNodeIds(WS)).toEqual(new Set([kid]));
      await publish();
      const served = (await loadServedSite(WS)).payload.nodes as Array<{ id: string; parent_id: string | null }>;
      expect(served).toEqual([expect.objectContaining({ id: kid, parent_id: null })]);
    });

    it("a member cannot use it; where the owner may not write, nothing is written", async () => {
      await setup();
      const root = await note("Root", "root");
      await note("Kid", "kid", { parent: root });
      currentActor = member;
      expect((await post("/api/publish/keep-off-subtree", { noteId: root })).status).toBe(403);
      currentActor = owner;
      // A note under it the owner may read but not write (the space gives them view only).
      await seedQ(`UPDATE space_members SET permission = 'view' WHERE space_id = $1 AND actor_id = $2`, [site, owner.id]);
      const res = await post("/api/publish/keep-off-subtree", { noteId: root });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await q(`SELECT 1 FROM node_attributes WHERE workspace_id = $1 AND key = '_published'`, [WS])).rows).toEqual([]);
    });
  });

  describe("3. the site is the workspace owner's", () => {
    const personalOf = async (a: ActorCtx) => (await q<{ id: string }>(
      `SELECT id::text FROM spaces WHERE workspace_id = $1 AND kind = 'personal' AND owner_actor_id = $2`, [WS, a.id])).rows[0]!.id;

    it("a member cannot switch their personal space onto the site; the owner can switch their own", async () => {
      await setup();
      const refused = await updateSpace(member, WS, await personalOf(member), { capabilities: { publish: true } }).catch((e) => e);
      expect(refused).toBeInstanceOf(SpaceMoveError);
      expect(refused).toMatchObject({ status: 403, code: "owner_only" });
      expect((await q(`SELECT capabilities->>'publish' AS p FROM spaces WHERE id = $1`, [await personalOf(member)])).rows[0]).toEqual({ p: "false" });
      await updateSpace(owner, WS, await personalOf(owner), { capabilities: { publish: true } });
      expect((await q(`SELECT capabilities->>'publish' AS p FROM spaces WHERE id = $1`, [await personalOf(owner)])).rows[0]).toEqual({ p: "true" });
      // Switching a personal space off stays allowed for its own person.
      await updateSpace(member, WS, await personalOf(member), { capabilities: { publish: false } });
    });

    it("a member's personal space is never on the site, even with the switch already on; the owner's is", async () => {
      await setup();
      const mine = await note("Member's", "member text", { space: await personalOf(member) });
      const theirs = await note("Owner's own", "owner text", { space: await personalOf(owner) });
      await seedQ(`UPDATE spaces SET capabilities = capabilities || '{"publish": true}'::jsonb WHERE id = ANY($1::uuid[])`, [[await personalOf(member), await personalOf(owner)]]);
      const ids = await publishedNodeIds(WS);
      expect(ids.has(mine)).toBe(false);
      expect(ids.has(theirs)).toBe(true);
    });
  });
});
