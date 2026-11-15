// Real PostgreSQL. Site config writes join the caller's transaction, so a
// config change commits or rolls back together with its event.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as db from "../db.js";
import { mutate } from "../spine/mutate.js";
import { getSiteConfig, patchSiteConfig, setChromeBlocks, getChromeBlocks, ensureConfigNodeId, findConfigNodeId } from "../services/siteConfig.js";
import { setSiteConfig } from "./helpers/siteConfigFixture.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let owner: ActorCtx = { id: "sc-owner", name: "Owner", role: "admin", type: "human" };

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("site config transactions", () => {
  beforeAll(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Site config',$1) RETURNING id", [randomUUID()])).rows[0].id;
    owner = await persistActor(ws, owner);
    await setSiteConfig(ws, { brand: "Before" });
  });
  afterAll(async () => { await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]); });

  it("a failed config mutation rolls back the config with its event", async () => {
    const countEvents = async () => (await db.q("SELECT 1 FROM domain_events WHERE workspace_id=$1 AND event_type='SITE_CONFIG_UPDATED'", [ws])).rows.length;
    const before = await countEvents();
    await expect(mutate({
      actor: owner, workspaceId: ws, authority: { kind: "principal_admin" },
      event: { type: "SITE_CONFIG_UPDATED", targetType: "workspace", targetId: ws, payload: { keys: ["brand"] } },
      apply: async () => {
        await patchSiteConfig(ws, { brand: "After" }, owner);
        await setChromeBlocks(ws, { blocks: ["after"] }, owner);
        throw new Error("later step failed");
      },
    })).rejects.toThrow("later step failed");
    expect((await getSiteConfig(ws)).brand).toBe("Before");
    expect(await getChromeBlocks(ws)).toBeNull();
    expect(await countEvents()).toBe(before);
  });

  it("the Site Config note is created by an attributed settings change, never by a read or a bare call", async () => {
    const fresh = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Fresh config',$1) RETURNING id", [randomUUID()])).rows[0].id;
    const admin = await persistActor(fresh, { id: "sc-fresh", name: "Fresh owner", role: "admin", type: "human" });
    expect(await getSiteConfig(fresh)).toEqual({});
    expect(await getChromeBlocks(fresh)).toBeNull();
    expect(await findConfigNodeId(fresh)).toBeNull();
    await expect(ensureConfigNodeId(fresh, admin)).rejects.toThrow();
    await expect(patchSiteConfig(fresh, { brand: "x" }, admin)).rejects.toThrow(/caller's transaction/);
    await expect(setChromeBlocks(fresh, {}, admin)).rejects.toThrow(/caller's transaction/);
    expect(await findConfigNodeId(fresh)).toBeNull();

    await mutate({
      actor: admin, workspaceId: fresh, authority: { kind: "principal_admin" },
      event: { type: "SITE_CONFIG_UPDATED", targetType: "workspace", targetId: fresh, payload: { keys: ["brand"] } },
      apply: async () => { await patchSiteConfig(fresh, { brand: "Fresh" }, admin); },
    });
    const nodeId = await findConfigNodeId(fresh);
    expect(nodeId).not.toBeNull();
    expect((await getSiteConfig(fresh)).brand).toBe("Fresh");
    const events = await db.q<{ event_type: string; actor_id: string; triggered_by: string | null }>(
      `SELECT event_type, actor_id FROM domain_events WHERE workspace_id=$1 ORDER BY id`, [fresh]);
    expect(events.rows.map((e) => e.event_type)).toEqual(["SITE_CONFIG_UPDATED", "TAG_CREATED", "NODE_CREATED"]);
    expect(new Set(events.rows.map((e) => e.actor_id))).toEqual(new Set([admin.id]));
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [fresh]);
  });
});
