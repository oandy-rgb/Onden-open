import { randomBytes, randomUUID } from "node:crypto";
import { getWorkspaceId, q } from "../../db.js";
import { createNote } from "../../services/noteCreate.js";
import { configureRunner, setRunnerEnabled, type AgentSession } from "../../services/agentSessions.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import type { ActorCtx } from "../../types.js";
import { makeSpace } from "./spaceFixtures.js";
import { persistActor } from "./persistActor.js";
import { setWorkspaceOwner } from "./setOwner.js";
import { setModulesOn } from "./setModulesOn.js";

/** A workspace with an owner, an agent that answers to @handle, and a shared
 *  space both are in (external AI on). Everything is stamped so tests can run
 *  in a shared database. */
export async function agentWorld(label: string, opts: { ownWorkspace?: { modules: string[] } } = {}) {
  let ws: string;
  if (opts.ownWorkspace) {
    // A workspace of its own, for the tests that switch modules on (#技能 needs "skills").
    ws = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Agent sessions', $1) RETURNING id::text`,
      [`agent-sessions-${randomUUID()}`])).rows[0]!.id;
    await setModulesOn(ws, opts.ownWorkspace.modules);
  } else {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
  }
  const stamp = `${label}${randomBytes(3).toString("hex")}`;
  const owner = await persistActor(ws, { id: "", name: `Owner ${stamp}`, role: "admin", type: "human" });
  await setWorkspaceOwner(ws, owner.id);
  const agent = await persistActor(ws, {
    id: "", name: `Claude ${stamp}`, role: "editor", type: "agent",
    tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
  });
  const space = await makeSpace(ws, `space ${stamp}`, [{ id: owner.id, role: "manager" }, { id: agent.id, role: "editor" }]);
  const handle = `a${randomBytes(3).toString("hex")}`;
  await configureRunner(ws, agent.id, { handle }, { actor: owner });
  await setRunnerEnabled(ws, agent.id, true, { actor: owner });
  const note = async (markdown: string, spaceId = space) =>
    (await createNote({ actor: owner, workspaceId: ws, title: `n ${stamp} ${randomUUID().slice(0, 6)}`, markdown, spaceId, event: { uiContext: "test" } })).node.id as string;
  const body = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
  return { ws, stamp, owner, agent, space, handle, note, body };
}

/** The session token a pull claim will mint (services/agentSessions claim, PR 2),
 *  made by hand so the core can be tested alone. */
export async function sessionActor(session: AgentSession, agent: ActorCtx): Promise<ActorCtx> {
  const id = (await q<{ id: string }>(
    `INSERT INTO agent_tokens (actor_id, token_hash, name, access, expires_at, issued_by, session_id)
     VALUES ($1, $2, 'session', 'write', $3, $4, $5) RETURNING id::text`,
    [agent.id, randomBytes(16).toString("hex"), session.deadline_at, session.initiator_id, session.id])).rows[0]!.id;
  return resolveCurrentActor({ id: agent.id, tokenScope: { tokenId: id } }, session.workspace_id);
}
