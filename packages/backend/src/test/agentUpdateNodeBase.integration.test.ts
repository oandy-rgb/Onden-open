// The agent's updateNode merges like the app's editors (D87). It used to send
// no base, so a body write replaced the whole note with the copy the agent
// had read earlier: a line the user added in between was gone, with no
// BODY_CONFLICT. Now a body needs base_markdown (refused without one), the
// save three-way merges, and lines both changed come back as `conflicts` and
// go to the inbox as BODY_CONFLICT.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import mcpRouter from "../routes/mcp.js";
import { callTool } from "../services/agentTools/index.js";
import { updateNode } from "../services/nodeUpdate.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

function appFor(actor: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/nodes", nodeRouter);
  // The tool surface answers with its own boundary (toolOnError).
  app.route("/api/mcp", mcpRouter);
  return app;
}

type Saved = { markdown: string; conflicts: Array<{ incoming: string; current: string }> };

describe.skipIf(!isTestDb)("agent updateNode sends its base (D87)", () => {
  let ws = "";
  let defaultSpace = "";
  const stamp = Date.now();
  const owner: ActorCtx = { id: "", name: "Owner", role: "admin", type: "human" };
  let agent: ActorCtx;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    Object.assign(owner, await persistActor(ws, owner));
    defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
    agent = await persistActor(ws, {
      id: "", name: `D87 agent ${stamp}`, role: "editor", type: "agent",
      tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
    });
    // persistActor made the agent an edit member of the default space: its whole reach.
  });

  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND title LIKE $2`, [ws, `D87 %${stamp}%`]);
    // Derivations a write queued run after its response; ending the pool under
    // them is an unhandled "pool after end" rejection that fails the file.
    await awaitAllDispatchers();
    await pool.end();
  });

  const note = async (title: string, markdown: string) => (await (await appFor(owner).request("/api/nodes", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `D87 ${title} ${stamp}`, markdown, space_id: defaultSpace }),
  })).json() as { id: string }).id;
  const body = async (id: string) =>
    (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
  const read = async (id: string) =>
    (await callTool("getNode", { id }, { actor: agent, workspaceId: ws }) as { markdown: string }).markdown;
  // The user's autosave: the editor sends the body it started from.
  const userSaves = (id: string, markdown: string, base: string) =>
    updateNode(ws, id, { markdown }, { actor: owner, baseMarkdown: base });

  it("keeps a line the user added after the agent read the note", async () => {
    const id = await note("merge", "A\n\nB\n");
    const seen = await read(id);
    await userSaves(id, "A\n\nB\n\nC\n", "A\n\nB\n");

    const saved = await callTool("updateNode", { id, markdown: "A2\n\nB\n", base_markdown: seen },
      { actor: agent, workspaceId: ws }) as Saved;

    expect(await body(id)).toBe("A2\n\nB\n\nC\n");
    expect(saved.markdown).toBe("A2\n\nB\n\nC\n");
    expect(saved.conflicts).toEqual([]);
  });

  it("refuses a body without base_markdown and leaves the note alone", async () => {
    const id = await note("no base", "A\n\nB\n");
    await userSaves(id, "A\n\nB\n\nC\n", "A\n\nB\n");

    await expect(callTool("updateNode", { id, markdown: "A2\n\nB\n" }, { actor: agent, workspaceId: ws }))
      .rejects.toThrow(/base_markdown/);
    const res = await appFor(agent).request("/api/mcp/tools/updateNode", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: { id, markdown: "A2\n\nB\n" } }),
    });
    expect(res.status).toBe(400);
    const refusal = await res.json() as { error: string; detail: Array<{ path: string[]; message: string }> };
    expect(refusal.error).toBe("invalid_args");
    expect(refusal.detail[0]).toMatchObject({ path: ["base_markdown"] });
    expect(refusal.detail[0]!.message).toMatch(/getNode/);
    expect(await body(id)).toBe("A\n\nB\n\nC\n");
  });

  it("a title alone needs no base", async () => {
    const id = await note("title", "A\n");
    const saved = await callTool("updateNode", { id, title: `D87 renamed ${stamp}` }, { actor: agent, workspaceId: ws }) as Saved & { title: string };
    expect(saved.title).toBe(`D87 renamed ${stamp}`);
    expect(await body(id)).toBe("A\n");
  });

  it("a title-only save (body equals its base) keeps the newer server body", async () => {
    const id = await note("title only", "A\n\nB\n");
    await userSaves(id, "A\n\nB\n\nFROM-B\n", "A\n\nB\n");

    const saved = await updateNode(ws, id, { title: `D87 renamed2 ${stamp}`, markdown: "A\n\nB\n" },
      { actor: owner, baseMarkdown: "A\n\nB\n" });

    expect(await body(id)).toBe("A\n\nB\n\nFROM-B\n");
    expect(JSON.stringify(saved)).toContain("FROM-B");
    const conflicts = await q(`SELECT 1 FROM domain_events WHERE event_type = 'BODY_CONFLICT' AND target_id = $1`, [id]);
    expect(conflicts.rows).toHaveLength(0);
  });

  it("a line both rewrote comes back as a conflict and goes to the inbox", async () => {
    // Both replace the same words (not only add to them: that merges, #672).
    const id = await note("conflict", "A old\n\nB\n");
    const seen = await read(id);
    await userSaves(id, "A user\n\nB\n", "A old\n\nB\n");

    const saved = await callTool("updateNode", { id, markdown: "A agent\n\nB\n", base_markdown: seen },
      { actor: agent, workspaceId: ws }) as Saved;

    expect(await body(id)).toBe("A agent\n\nB\n");
    expect(saved.conflicts).toHaveLength(1);
    expect(saved.conflicts[0]).toMatchObject({ incoming: "A agent\n", current: "A user\n" });
    const conflict = await q<{ payload: { overridden_preview: string; incoming_actor_id: string } }>(
      `SELECT payload FROM domain_events WHERE event_type = 'BODY_CONFLICT' AND target_id = $1`, [id]);
    expect(conflict.rows).toHaveLength(1);
    expect(conflict.rows[0]!.payload).toMatchObject({ overridden_preview: "A user\n\nB\n", incoming_actor_id: agent.id });
  });

  it("text the person and the agent both added at one point is kept twice over", async () => {
    const id = await note("both-add", "A\n\nB\n");
    const seen = await read(id);
    await userSaves(id, "A-user\n\nB\n", "A\n\nB\n");
    const saved = await callTool("updateNode", { id, markdown: "A-agent\n\nB\n", base_markdown: seen },
      { actor: agent, workspaceId: ws }) as Saved;
    expect(await body(id)).toBe("A-agent-user\n\nB\n");
    expect(saved.conflicts ?? []).toHaveLength(0);
  });

  it("a dry run previews the merge and its conflicts without writing", async () => {
    const id = await note("dry", "A\n\nB\n");
    const seen = await read(id);
    await userSaves(id, "A\n\nB\n\nC\n", "A\n\nB\n");
    const preview = await callTool("updateNode", { id, markdown: "A2\n\nB\n", base_markdown: seen },
      { actor: agent, workspaceId: ws, dryRun: true }) as Saved;
    expect(preview.markdown).toBe("A2\n\nB\n\nC\n");
    expect(await body(id)).toBe("A\n\nB\n\nC\n");
  });
});
