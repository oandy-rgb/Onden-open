// GAP-260: the workspace-config tag and the Site Config node hold the
// workspace settings. Ordinary node routes must not let a non-owner change or
// delete them (a self-signup viewer used to wipe the settings by DELETE-ing
// both). Real REST router, agent tool and database; only the actor is injected.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { getSiteConfig } from "../services/siteConfig.js";
import { updateNode } from "../services/agentTools/updateNode.js";
import { AuthorityError } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";
import { ensureConfigNode, setSiteConfig } from "./helpers/siteConfigFixture.js";

let workspaceId: string;
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));

// Every actor works in 共用 (view for "viewer", edit otherwise), so a 403 on
// the config nodes is the config guard, not a space gap. "admin" is the
// workspace owner: the first human of the workspace (beforeAll), who the
// owner-less workspace would otherwise hand ownership to.
async function actor(role: "viewer" | "editor" | "admin"): Promise<ActorCtx> {
  return persistActor(workspaceId, { id: "", name: `${role} ${randomUUID()}`, role, type: "human" });
}
async function call(identity: ActorCtx, method: string, path: string, body?: unknown) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", identity); await next(); });
  app.route("/api/nodes", nodesRouter);
  const res = await app.request(`/api/nodes${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status;
}
async function live(id: string) {
  return (await db.q("SELECT 1 FROM content_nodes WHERE id=$1 AND deleted_at IS NULL", [id])).rows.length > 0;
}
async function note() {
  const id = randomUUID();
  await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
    VALUES($1::uuid,$2,'manual','content','Ordinary',($1::uuid)::text,'body')`, [id, workspaceId]);
  return id;
}

describe.skipIf(!isTestDatabase())("workspace-config nodes need the owner (GAP-260)", () => {
  let configNode = "", configTag = "";
  let owner: ActorCtx;
  beforeAll(async () => {
    workspaceId = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Reserved config',$1) RETURNING id", [randomUUID()])).rows[0].id;
    owner = await actor("admin");
    configNode = await ensureConfigNode(workspaceId);
    configTag = (await db.q<{ tag_id: string }>("SELECT tag_id FROM node_tags WHERE node_id=$1", [configNode])).rows[0].tag_id;
    await setSiteConfig(workspaceId, { tagline: "owner tagline", brand: "Owner Brand" });
  });
  afterAll(async () => {
    if (!workspaceId) return;
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [workspaceId]);
    await deleteWorkspaceActors(workspaceId);
  });

  for (const role of ["viewer", "editor"] as const) {
    it(`${role} cannot delete, edit or re-tag the config nodes, and the settings survive`, async () => {
      const who = await actor(role);
      const other = await note();
      expect(await call(who, "DELETE", `/${configNode}`)).toBe(403);
      expect(await call(who, "DELETE", `/${configTag}`)).toBe(403);
      expect(await call(who, "PATCH", `/${configNode}`, { title: "hijacked" })).toBe(403);
      expect(await call(who, "PUT", `/${configNode}/attributes/tagline`, { value: "x", value_type: "text" })).toBe(403);
      expect(await call(who, "DELETE", `/${configNode}/tags/${configTag}`)).toBe(403);
      expect(await call(who, "PUT", `/${other}/tags/${configTag}`)).toBe(403);
      expect(await live(configNode)).toBe(true);
      expect(await live(configTag)).toBe(true);
      const cfg = await getSiteConfig(workspaceId);
      expect(cfg.tagline).toBe("owner tagline");
      expect(cfg.brand).toBe("Owner Brand");
      expect((await db.q("SELECT 1 FROM node_tags WHERE node_id=$1 AND tag_id=$2", [other, configTag])).rows.length).toBe(0);
    });
  }

  it("the agent updateNode tool is refused on the config node for a non-owner", async () => {
    const editor = await actor("editor");
    await expect(updateNode.handler({ id: configNode, title: "agent hijack" }, { actor: editor, workspaceId, dryRun: false }))
      .rejects.toBeInstanceOf(AuthorityError);
    expect((await db.q<{ title: string }>("SELECT title FROM content_nodes WHERE id=$1", [configNode])).rows[0].title).toBe("Site Config");
  });

  it("the settings are not a note, not even for the owner: they change through the settings API", async () => {
    // Migration 096: the Site Config note lives in a system space no one reads
    // or writes as a note; PATCH /api/workspace/config (owner-only) and the
    // settings functions are the way in.
    const before = (await getSiteConfig(workspaceId)).tagline;
    expect(await call(owner, "PUT", `/${configNode}/attributes/tagline`, { value: "owner tagline 2", value_type: "text" })).toBe(403);
    expect((await getSiteConfig(workspaceId)).tagline).toBe(before);
  });

  it("ordinary notes keep the existing contract (no policy → editor may delete)", async () => {
    const editor = await actor("editor");
    const other = await note();
    expect(await call(editor, "DELETE", `/${other}`)).toBe(200);
    expect(await live(other)).toBe(false);
  });
});
