// A note marked for the site that the site leaves out is named in the publish
// preview and the publish response, with the reason (the owner's complaint:
// "I marked it, I published, the site is empty and nothing says why").
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import publishRouter from "../modules/website/routes.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { persistActor } from "./helpers/persistActor.js";
import { moveToSpace } from "../services/spaces.js";
import { makeSpace, putInSpace, publishDefaultSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import type { PublishPreview } from "@onden/contract";
import { seedQ } from "./helpers/seedQ.js";
import { publishWithPreview } from "./helpers/publishWithPreview.js";

let WS = "";
vi.mock("../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db.js")>()),
  getWorkspaceId: async () => WS,
}));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api", publishRouter);
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const preview = async () => (await (await post("/api/publish/preview", { title: "Site" })).json()) as PublishPreview;

describe.skipIf(!isTestDb)("publish: marked notes the site leaves out", () => {
  let owner: ActorCtx;
  let personal = "";
  beforeEach(async () => {
    const stamp = randomUUID().replace(/-/g, "").slice(0, 12);
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('LeftOut', $1) RETURNING id::text`, [`left-out-${stamp}`])).rows[0]!.id;
    await publishDefaultSpace(WS);
    owner = await persistActor(WS, { id: "owner-left-out", name: "Owner", role: "admin", type: "human" });
    personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND kind = 'personal' AND owner_actor_id = $2`, [WS, owner.id])).rows[0]!.id;
    currentActor = owner;
  });

  /** A note in `spaceId`, marked for the site through the real attribute write. */
  async function markedNote(title: string, spaceId: string | null, extra: { hidden?: boolean; by?: ActorCtx } = {}): Promise<string> {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden)
       VALUES ($1,'manual','content',$2,$3,'body',$4) RETURNING id::text`,
      [WS, title, `${randomUUID().slice(0, 8)}`, extra.hidden ?? false])).rows[0]!.id;
    if (spaceId) await putInSpace(id, spaceId);
    await setNodeAttribute({ workspaceId: WS, actor: extra.by ?? owner, nodeId: id,
      attribute: { key: "_published", value: "true", value_type: "bool", is_inheritable: false } });
    return id;
  }

  it("a note marked in the personal space is listed with its space and the reason", async () => {
    const id = await markedNote("My page", personal);
    const p = await preview();
    expect(p.site.payload.nodes).toEqual([]);
    expect(p.left_out).toEqual([{
      node_id: id, title: "My page", reason: "space_not_published",
      space: { id: personal, kind: "personal", is_default: false, name: "personal" },
    }]);
  });

  it("E06: an untitled note in the default space (publish on) reaches the preview", async () => {
    const id = await markedNote("", null);
    const p = await preview();
    expect((p.site.payload.nodes as Array<{ id: string }>).map((n) => n.id)).toEqual([id]);
    expect(p.left_out).toEqual([]);
  });

  it("E06: marked in the personal space, then moved to Everyone through the product path, it is published", async () => {
    const id = await markedNote("未命名", personal);
    const everyone = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    expect((await preview()).left_out.map((n) => n.node_id)).toEqual([id]);
    await moveToSpace(owner, WS, id, everyone, null);
    const p = await preview();
    expect((p.site.payload.nodes as Array<{ id: string }>).map((n) => n.id)).toEqual([id]);
    expect(p.left_out).toEqual([]);
  });

  it("a hidden note is listed as hidden; a shared space with publish off as its space", async () => {
    const hidden = await markedNote("Hidden one", null, { hidden: true });
    const closed = await makeSpace(WS, "Closed", [{ id: owner.id, permission: "edit" }]);
    const inClosed = await markedNote("In closed", closed);
    const p = await preview();
    const byId = new Map(p.left_out.map((n) => [n.node_id, n]));
    expect(byId.get(hidden)?.reason).toBe("hidden");
    expect(byId.get(inClosed)).toMatchObject({ reason: "space_not_published", space: { id: closed, kind: "shared", name: "Closed" } });
  });

  it("another member's private note is not named to the owner", async () => {
    const member = await persistActor(WS, { id: "member-left-out", name: "Member", role: "editor", type: "human" });
    const theirs = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND kind = 'personal' AND owner_actor_id = $2`, [WS, member.id])).rows[0]!.id;
    await markedNote("Their secret", theirs, { by: member });
    expect((await preview()).left_out).toEqual([]);
  });

  it("the publish response carries the same list, even when the site comes out empty", async () => {
    const id = await markedNote("My page", personal);
    const res = await publishWithPreview(post, { title: "Site" });
    expect(res.status).toBe(201);
    const body = await res.json() as { left_out: Array<{ node_id: string; reason: string }> };
    expect(body.left_out.map((n) => [n.node_id, n.reason])).toEqual([[id, "space_not_published"]]);
  });
});
