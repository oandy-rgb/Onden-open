// Random add / remove / module-tag-delete sequences on one tag's function (scan 06 M2), through the REAL routes.
//
// The tag has at most one reference to the "skills" function. Its state:
//   none   no reference
//   via    the reference points at the live module tag
//   self   the reference points at the tag itself (added while no module tag existed)
//   stale  the reference points at a module tag that was deleted
// Commands: add (PUT), remove (DELETE), delete the module tag (DELETE /api/nodes), enable the module again (a new module tag).
// Invariants after every command:
//   • the function is offered (functionsOf) exactly when the state is via or self
//   • at most one reference row per tag and function
//   • add answers 200 and always leaves the function offered (never "added: false" while it is hidden)
//   • remove answers 200 for any existing reference, also a stale one, and 404 only for none
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/tagFunctionRefs.property.integration.test.ts
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, pool } from "../../db.js";
import { apiOnError } from "../../httpError.js";
import nodesRouter from "../../routes/nodes.js";
import tagsRouter from "../../routes/tags.js";
import workspaceRouter from "../../routes/workspace.js";
import { functionsOf } from "../../services/functionRefs.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { seedQ } from "../helpers/seedQ.js";
import { checkAsync } from "../helpers/propsConfig.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));
let owner: ActorCtx;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", owner); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/tags", tagsRouter);
app.route("/api/workspace", workspaceRouter);

const FUNCTION_ID = "skills";
type State = "none" | "via" | "self" | "stale";
type Command = "add" | "remove" | "deleteModule" | "enableModule";

async function call(method: string, path: string, json?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const res = await app.request(path, { method, headers: json === undefined ? {} : { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

class World {
  tagId = "";
  moduleTagId: string | null = null;
  state: State = "none";

  static async make(): Promise<World> {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Function refs', $1) RETURNING id::text`, [`function-refs-${randomUUID()}`])).rows[0]!.id;
    owner = await persistActor(WS, { id: "fr-owner", name: "Owner", role: "admin", type: "human" });
    const world = new World();
    await world.enableModule();
    const tag = await call("POST", "/api/tags", { name: `t${randomUUID().slice(0, 6)}` });
    expect(tag.status, JSON.stringify(tag.body)).toBeLessThan(300);
    world.tagId = tag.body.id;
    return world;
  }

  async enableModule(): Promise<void> {
    expect((await call("PATCH", "/api/workspace/modules", { module: "ai", imported: true })).status).toBe(200);
    const res = await call("PATCH", "/api/workspace/modules", { module: FUNCTION_ID, imported: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    this.moduleTagId = res.body.module_tag_id;
  }

  async run(command: Command): Promise<string> {
    switch (command) {
      case "add": {
        const res = await call("PUT", `/api/tags/${this.tagId}/functions/${FUNCTION_ID}`, {});
        expect(res.status, `add: ${JSON.stringify(res.body)}`).toBe(200);
        if (this.state === "none" || this.state === "stale") this.state = this.moduleTagId ? "via" : "self";
        return "add";
      }
      case "remove": {
        const res = await call("DELETE", `/api/tags/${this.tagId}/functions/${FUNCTION_ID}`);
        expect(res.status, `remove in state ${this.state}: ${JSON.stringify(res.body)}`).toBe(this.state === "none" ? 404 : 200);
        this.state = "none";
        return "remove";
      }
      case "deleteModule": {
        if (!this.moduleTagId) return "deleteModule (no module tag)";
        // A module's tag cannot be deleted while the module is on (reservedTags.assertTagDefinitionChange, 409 module_tag), so this
        // builds the legacy state a workspace can still hold — a module on with its tag deleted before that rule — by taking the
        // module mark off for the one real delete call and putting it back on the trashed row.
        const refused = await call("DELETE", `/api/nodes/${this.moduleTagId}`);
        expect(refused.status, `delete while on: ${JSON.stringify(refused.body)}`).toBe(409);
        await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema - 'module' WHERE id = $1`, [this.moduleTagId]);
        const res = await call("DELETE", `/api/nodes/${this.moduleTagId}`);
        expect(res.status, `delete module tag: ${JSON.stringify(res.body)}`).toBeLessThan(300);
        await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || jsonb_build_object('module', $2::text) WHERE id = $1`, [this.moduleTagId, FUNCTION_ID]);
        this.moduleTagId = null;
        if (this.state === "via") this.state = "stale";
        return "deleteModule";
      }
      case "enableModule":
        if (!this.moduleTagId) await this.enableModule();
        return "enableModule";
    }
  }

  async verify(where: string): Promise<void> {
    const offered = (await functionsOf(owner, { kind: "node", id: this.tagId }))?.some((use) => use.functionId === FUNCTION_ID && use.instance === "");
    expect(offered, `${where}: function offered`).toBe(this.state === "via" || this.state === "self");
    const rows = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM function_refs WHERE holder_node_id = $1 AND function_id = $2 AND instance = ''`, [this.tagId, FUNCTION_ID])).rows[0]!.n;
    expect(Number(rows), `${where}: reference rows`).toBe(this.state === "none" ? 0 : 1);
  }
}

async function play(commands: Command[]): Promise<void> {
  const world = await World.make();
  for (const [step, command] of commands.entries()) {
    const label = await world.run(command);
    await world.verify(`#${step + 1} ${label} → ${world.state}`);
  }
}

beforeAll(() => { if (isTestDb) registerShippedModules(); });
afterAll(async () => { if (isTestDb) await pool.end(); });

describe.skipIf(!isTestDb)("a tag's function when its module tag is deleted", () => {
  it("random command sequences", async () => {
    await checkAsync(fc.asyncProperty(
      fc.array(fc.constantFrom<Command>("add", "remove", "deleteModule", "enableModule"), { minLength: 1, maxLength: 10 }),
      play,
    ), 20);
  }, 300_000);

  it("M2: delete the module tag, enable it again, add the function again: it is offered", async () => {
    await play(["add", "deleteModule", "enableModule", "add"]);
  });

  it("M2: a reference whose module tag was deleted can still be taken off", async () => {
    await play(["add", "deleteModule", "remove"]);
  });
});
