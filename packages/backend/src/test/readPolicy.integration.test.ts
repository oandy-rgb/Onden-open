// Read authorization (Phase B) against a real Postgres. A node in a space the
// actor is not a member of must be
// unreadable — versions/attributes/etc. return 404, like a missing node — while unrestricted nodes
// stay readable. This is the read-side counterpart to the spine's write gate.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodeRouter);

const status = async (id: string): Promise<number> => (await app.request(`/api/nodes/${id}/versions`)).status;

describe.skipIf(!isTestDb)("read policy (DB)", () => {
  let WS = "";
  let open = "";       // unrestricted node
  let restricted = ""; // node in an admin-only space
  let viewer: ActorCtx;
  let admin: ActorCtx;

  beforeAll(async () => {
    WS = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Test','default')
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    )).rows[0]!.id;

    const mk = async (title: string) =>
      (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1,'manual','content',$2,$3,'x') RETURNING id`,
        [WS, title, `${title}-${Date.now()}`],
      )).rows[0]!.id;
    open = await mk("open");
    restricted = await mk("restricted");

    viewer = await persistActor(WS, { id: "", name: "V", role: "viewer", type: "human" });
    admin = await persistActor(WS, { id: "", name: "A", role: "admin", type: "human" });
    // The restricted node lives in a space only the admin belongs to.
    await putInSpace(restricted, await adminOnlySpace(WS, `secret-${Date.now()}`, [admin.id]));
  });

  const asViewer = () => { currentActor = viewer; };
  const asAdmin = () => { currentActor = admin; };

  it("viewer can read an unrestricted node but NOT an admin-read-gated one", async () => {
    asViewer();
    expect(await status(open)).toBe(200);
    expect(await status(restricted)).toBe(404); // unreadable answers like missing
  });

  it("admin can read the gated node", async () => {
    asAdmin();
    expect(await status(restricted)).toBe(200);
  });
});
