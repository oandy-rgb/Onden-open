// Pieces both simulator test files share: the plain-words trace of a failed run.
import { q } from "../../../db.js";
import { seedQ } from "../seedQ.js";
import { describeOp, type Op, type World } from "./ops.js";

/** Every request the server handled, in its order, with notes named by creation number. */
export const trace = (w: World) => w.server.handled.map((h) => {
  const name = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (id) => w.label(id));
  const body = h.body ? ` ${name(JSON.stringify(h.body))}` : "";
  return `  ${String(h.seq + 1).padStart(2)}. ${h.client} ${h.method} ${name(h.path)}${body} -> ${h.status}${h.replyLost ? " (reply lost)" : ""}`;
}).join("\n");

export const plain = (ops: Op[]) => ops.map((op, i) => `${String(i + 1).padStart(2)}. ${describeOp(op)}`).join("\n");

/** What to append to a failure message: the server's trace and the events recorded since the run began. */
export async function failureContext(world: World, workspaceId: string): Promise<string> {
  const events = await q<{ id: string; event_type: string; target_id: string }>(
    `SELECT id::text, event_type, target_id FROM domain_events WHERE workspace_id = $1 AND id > $2::bigint ORDER BY domain_events.id`, [workspaceId, world.startCursor]);
  return `\n\nWhat the server received, in order:\n${trace(world)}` +
    `\n\nEvents after the run started (devices' cursors: ${world.clients.map((c) => `${c.name}=${c.cursor}`).join(", ")}):\n` +
    events.rows.map((e) => `  ${e.id} ${e.event_type} ${world.label(e.target_id)}`).join("\n");
}

/** The single-account run shares one workspace across runs: every run starts with no review cards and no schedules, so a device's
 *  queue holds this run's cards only (earlier runs' enrolled notes would otherwise fill it and use up its daily cap). */
export async function resetReviewData(workspaceId: string): Promise<void> {
  await seedQ(`DELETE FROM function_refs WHERE workspace_id = $1 AND function_id = 'review' AND instance = ''`, [workspaceId]);
  await seedQ(`DELETE FROM review_states WHERE workspace_id = $1`, [workspaceId]);
}
