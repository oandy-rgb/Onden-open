// "The write was committed but the response is 401" (PR #1875, the security review's condition 2; documented in
// docs/architecture/agent-delegation.md). callTool (services/agentTools/registry.ts) runs a tool's handler — whose write commits in its own
// transaction (mutate → withEventTransaction) — and only then writes the AGENT_TOOL_CALLED audit record in a second transaction
// (appendEventAsCurrentActor). An agent removed in that gap: the write stands (it was authorized when it committed), the audit re-read finds
// no actor, the failure record cannot be written either, and the request is answered 401 like a credential that never existed.
// The gap is made deterministic by removing the agent at the start of the audit write (a wrapper around the real
// appendEventAsCurrentActor), which is exactly "after the tool's commit, before the audit takes the lock". The one-line log is checked too.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { CLIENT_PROTOCOL } from "@onden/markdown";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { createToken } from "../services/agentTokens.js";
import { toolsForAccess } from "../services/agentTools/index.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";
import { newNote, standardWorld } from "./helpers/sessionWorld.js";

registerShippedModules();

let ownWorkspace = "";
/** The agent to remove when its next audit record is about to be written (null: none). */
let removeAtAudit: string | null = null;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
vi.mock("../spine/currentActor.js", async (original) => {
  const real = await original<typeof import("../spine/currentActor.js")>();
  return {
    ...real,
    appendEventAsCurrentActor: async (...args: Parameters<typeof real.appendEventAsCurrentActor>) => {
      const [actor, workspaceId] = args;
      if (removeAtAudit === actor.id) {
        removeAtAudit = null;
        // Committed before the audit's transaction begins, as the owner's removal would be (it takes the same lock; raw SQL here, so it
        // records no ACTOR_DELETED and the event count below is the request's alone).
        await pool.query(`DELETE FROM actors WHERE workspace_id = $1 AND id = $2`, [workspaceId, actor.id]);
      }
      return real.appendEventAsCurrentActor(...args);
    },
  };
});
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
  configuredSocialProviders: [],
}));
const { app } = await import("../app.js");

describe.skipIf(!isTestDatabase())("a write tool's agent is removed after its write committed, before its audit record", () => {
  let w: Awaited<ReturnType<typeof standardWorld>>;
  let logged: string[] = [];
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  beforeAll(async () => {
    w = await standardWorld("toolWriteThenGone");
    ownWorkspace = w.ws;
    await turnModuleOn(w.ws, "ai");
    for (const level of ["log", "info", "warn", "error"] as const) {
      spies.push(vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); }));
    }
  });
  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    await pool.end();
  });

  it("the write stands, nothing records the call, the answer is 401 like a never-issued token, and one line is logged", async () => {
    const agent = (await q<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1, $2, 'agent') RETURNING id::text`, [w.ws, `agent-${randomUUID()}`])).rows[0]!.id;
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit')`, [w.spaceA, agent]);
    const token = await createToken(agent, { access: "write", allowedTools: toolsForAccess("write") });
    const note = await newNote(w.ws, "before", w.spaceA, "body");
    logged = [];

    removeAtAudit = agent;
    const res = await app.request("/api/mcp/tools/updateNode", {
      method: "POST",
      headers: { "x-onden-client-protocol": String(CLIENT_PROTOCOL), authorization: `Bearer ${token.plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({ args: { id: note, title: "written by the agent", base_markdown: "body" } }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(removeAtAudit, "the removal ran in the gap").toBeNull();
    // Committed: the note changed, under the agent's NODE_UPDATED (it was a member when that committed).
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [note])).rows[0]!.title).toBe("written by the agent");
    expect((await q(`SELECT 1 FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_UPDATED' AND actor_id = $2`, [note, agent])).rowCount).toBe(1);
    // Neither audit record exists: the database refuses an event for an actor that no longer exists.
    expect((await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND event_type IN ('AGENT_TOOL_CALLED', 'AGENT_TOOL_FAILED') AND tx_meta->>'token_id' = $2`, [w.ws, token.id])).rowCount).toBe(0);
    const gone = logged.filter((line) => line.includes("[auth]") && line.includes("gone since this request signed in"));
    expect(gone).toHaveLength(1);
    expect(gone[0]).toContain(token.id);
    for (const line of logged) {
      expect(line).not.toContain(token.plaintext);
      expect(line).not.toContain(agent);
    }
  });
});
