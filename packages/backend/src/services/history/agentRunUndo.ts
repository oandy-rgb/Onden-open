// Undo and redo of one agent run (History → "復原這次修改").
//
// For each chosen note, with  pre = the body before the run's first write,
// end = the body after its last write, now = the body today:
//
//   undo   three-way merge, base = end, theirs = pre, ours = now:
//          what the agent changed goes back, what a person wrote since stays.
//   redo   base = pre, theirs = end, ours = now (the same change, applied again).
//
// A line both sides changed keeps `now` in the note and the other side goes to
// the inbox as BODY_CONFLICT (updateNode keepOnConflict: "current"), so
// nothing a person wrote is overwritten. The merge runs inside updateNode,
// under the workspace event lock and the current write policy; one note's
// refusal leaves the others alone. Each save is a normal NODE_UPDATED whose
// tx_meta names the run (undoes_agent_run + agent_run_action), which is also
// how a run knows it is undone.
//
// Only the body goes back. A note the run created has no earlier body and is
// skipped; a title the agent changed stays.

import { q } from "../../db.js";
import { loadSession, sessionIsOpen } from "../agentSessionStore.js";
import { AuthorityError } from "../../spine/authority.js";
import { ScopeError } from "../../spine/toolScope.js";
import { NodeUpdateError, updateNode } from "../nodeUpdate.js";
import type { ActorCtx } from "../../types.js";
import { findAgentRun, type AgentRun } from "./agentRuns.js";
import { bodiesByHash } from "./bodyEvents.js";
import { StatusError } from "../../statusError.js";

export class AgentRunError extends StatusError {
  constructor(message: string, status: 404 | 409) {
    super(status, message);
    this.name = "AgentRunError";
  }
}

export type RunRevertResult = {
  /** Notes now in the state the action asked for (including already there). */
  undone: string[];
  /** Notes whose overlapping lines went to the inbox. Also in `undone`. */
  conflicts: string[];
  /** Notes left untouched: not in the run, nothing to go back to, no write permission. */
  skipped: string[];
};

/** A marker only counts while the run has not written the note again: a later
 *  write of the same run (a session still going) puts the agent's text back. */
function markerStillHolds(marker: Marker | undefined, note: { lastEventId: string }): Marker | undefined {
  return marker && BigInt(marker.eventId) > BigInt(note.lastEventId) ? marker : undefined;
}

type Marker = { action: "undo" | "redo"; eventId: string };

/** Per note, the latest undo/redo of this run. */
export async function runMarkers(workspaceId: string, runId: string): Promise<Map<string, Marker>> {
  const r = await q<{ target_id: string; action: "undo" | "redo"; event_id: string }>(
    `SELECT DISTINCT ON (e.target_id) e.target_id, e.tx_meta->>'agent_run_action' AS action, e.id::text AS event_id
       FROM domain_events e
      WHERE e.workspace_id = $1 AND e.event_type = 'NODE_UPDATED'
        AND e.tx_meta->>'undoes_agent_run' = $2
      ORDER BY e.target_id, e.id DESC`,
    [workspaceId, runId],
  );
  return new Map(r.rows.map((m) => [m.target_id, { action: m.action, eventId: m.event_id }]));
}

/** Whether every note of the run that can go back has been sent back. */
export async function isRunUndone(workspaceId: string, run: AgentRun): Promise<boolean> {
  const goBack = run.notes.filter((n) => !n.created && n.preHash !== null);
  if (goBack.length === 0) return false;
  const markers = await runMarkers(workspaceId, run.runId);
  return goBack.every((n) => markerStillHolds(markers.get(n.nodeId), n)?.action === "undo");
}

export function undoAgentRun(workspaceId: string, runId: string, nodeIds: string[], opts: { actor: ActorCtx }): Promise<RunRevertResult> {
  return revertRun(workspaceId, runId, nodeIds, "undo", opts);
}

export function redoAgentRun(workspaceId: string, runId: string, nodeIds: string[], opts: { actor: ActorCtx }): Promise<RunRevertResult> {
  return revertRun(workspaceId, runId, nodeIds, "redo", opts);
}

async function revertRun(
  workspaceId: string, runId: string, nodeIds: string[], action: "undo" | "redo", { actor }: { actor: ActorCtx },
): Promise<RunRevertResult> {
  const run = await findAgentRun(actor, workspaceId, runId);
  if (!run) throw new AgentRunError("agent run not found", 404);
  // One run is the whole session: while it can still write, an undo now would be
  // overtaken by its next write (agentSessions.revertSession asks the same).
  if (run.sessionId) {
    const session = await loadSession(run.sessionId);
    if (session && session.workspace_id === workspaceId && sessionIsOpen(session.status)) throw new AgentRunError("the agent is still working on this run", 409);
  }
  const markers = await runMarkers(workspaceId, runId);
  const notes = new Map(run.notes.map((n) => [n.nodeId, n]));
  const bodies = await bodiesByHash(run.notes.flatMap((n) => [n.endHash, ...(n.preHash ? [n.preHash] : [])]));

  const result: RunRevertResult = { undone: [], conflicts: [], skipped: [] };
  for (const nodeId of new Set(nodeIds)) {
    const note = notes.get(nodeId);
    const marker = note ? markerStillHolds(markers.get(nodeId), note) : undefined;
    // undo takes the agent's change out (end → pre); redo puts the same change
    // back (pre → end). A redo needs an undo before it.
    const target = action === "undo" ? note?.preHash : note?.endHash;
    const base = action === "undo" ? note?.endHash : note?.preHash;
    const targetBody = target ? bodies.get(target) : undefined;
    const baseBody = base ? bodies.get(base) : undefined;
    if (!note || note.created || targetBody === undefined || baseBody === undefined || (action === "redo" && marker?.action !== "undo")) {
      result.skipped.push(nodeId);
      continue;
    }
    // Already where it was asked to be (a retry after a lost response).
    if (marker?.action === action) {
      result.undone.push(nodeId);
      continue;
    }
    try {
      const saved = await updateNode(workspaceId, nodeId, { markdown: targetBody }, {
        actor,
        baseMarkdown: baseBody,
        keepOnConflict: "current",
        event: {
          uiContext: `history.agent_run.${action}`,
          txMeta: { undoes_agent_run: runId, agent_run_action: action },
          cascadeLabel: `history.agent_run.${action}.cascade`,
          backupPrefix: "NODE_UPDATED",
        },
      });
      result.undone.push(nodeId);
      if (saved.bodyConflicts.length > 0) result.conflicts.push(nodeId);
    } catch (error) {
      if (error instanceof AuthorityError || error instanceof ScopeError || (error instanceof NodeUpdateError && error.status === 404)) {
        result.skipped.push(nodeId);
        continue;
      }
      throw error;
    }
  }
  return result;
}
