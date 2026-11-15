import { Hono } from "hono";
import { z } from "zod";
import type { ActorCtx } from "../types.js";
import { requireActor } from "../spine/actor.js";
import { toolOnError } from "../httpError.js";
import { checkRateLimit } from "../services/agentTools/index.js";
import { subscribeRealtime } from "../services/realtime.js";
import {
  AgentSessionError, appendEvent, claimSession, finish, loadSession, pendingSessions,
} from "../services/agentSessions.js";
import { touchRunnerSeen } from "../services/aiRoles.js";
import { parseBody } from "./params.js";
import { parseCount } from "../services/paging.js";

// The runner's side of an agent session (proposal §3.3; the runner always
// PULLS). Under /api/mcp because a bearer token reaches nothing else
// (index.ts). Two kinds of token, never interchangeable:
//   resident token (the agent's own)  GET /pending, POST /:id/claim
//   session token (minted by claim)   POST /:id/events, POST /:id/finish, GET /:id
// Every handler is a thin call into services/agentSessions.ts; errors are the
// AgentSessionError codes (httpError.ts), rate limits the shared 429.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();
router.onError(toolOnError);

const MAX_WAIT_SECONDS = 25;
/** Metered per agent, apart from the tool calls' own 60/min (agentTools/rateLimit.ts). */
const PULL_PER_MINUTE = 60;
const EVENTS_PER_MINUTE = 240;

/** Resolve on the next committed-event tick, the timeout or the client leaving. */
function nextTick(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); unsubscribe(); signal.removeEventListener("abort", done); resolve(); };
    const unsubscribe = subscribeRealtime((tick) => { if (tick.kind === "changed") done(); });
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

// GET /api/mcp/sessions/pending?wait=25 — the sessions this runner can take.
// Long poll: with none and wait > 0 it holds until a domain event commits (a
// new session's AGENT_SESSION_STARTED is one) and looks again, up to `wait`
// seconds, so a mention reaches the runner in about a second.
router.get("/pending", async (c) => {
  const actor = requireActor(c.get("actor"));
  await checkRateLimit(`agent:pull:${actor.id}`, PULL_PER_MINUTE);
  await touchRunnerSeen(actor.id); // "the runner is online" is computed from this
  const wait = parseCount(c.req.query("wait"), { fallback: 0, min: 0, max: MAX_WAIT_SECONDS });
  if (wait === null) return c.json({ error: `wait must be 0–${MAX_WAIT_SECONDS}` }, 400);
  const until = Date.now() + wait * 1000;
  let sessions = await pendingSessions(actor);
  while (sessions.length === 0 && Date.now() < until && !c.req.raw.signal.aborted) {
    await nextTick(until - Date.now(), c.req.raw.signal);
    sessions = await pendingSessions(actor);
  }
  return c.json({ sessions });
});

// POST /api/mcp/sessions/:id/claim — atomic take (409 when held by another or no longer open).
router.post("/:id/claim", async (c) => {
  const actor = requireActor(c.get("actor"));
  await checkRateLimit(`agent:pull:${actor.id}`, PULL_PER_MINUTE);
  return c.json(await claimSession(c.req.param("id"), { actor }));
});

/** The session of a session token's URL: its agent, its token. */
async function ownSession(actor: ActorCtx, id: string) {
  const session = await loadSession(id);
  if (!session || session.agent_actor_id !== actor.id) throw new AgentSessionError("not_found", "session not found", 404);
  return session;
}

// GET /api/mcp/sessions/:id — the status, so a runner can notice a cancel without writing a log line.
router.get("/:id", async (c) => {
  const actor = requireActor(c.get("actor"));
  const s = await ownSession(actor, c.req.param("id"));
  return c.json({ id: s.id, status: s.status, fail_code: s.fail_code, deadline_at: s.deadline_at });
});

const EventBody = z.object({
  seq: z.number().int(),
  kind: z.enum(["ack", "thought", "action", "message", "error", "result"]),
  text: z.string().max(20_000).optional(),
  tool: z.string().max(200).optional(),
  target_id: z.string().max(200).optional(),
});

// POST /api/mcp/sessions/:id/events — progress line; kind "ack" starts the run.
router.post("/:id/events", async (c) => {
  const actor = requireActor(c.get("actor"));
  await checkRateLimit(`agent:events:${actor.id}`, EVENTS_PER_MINUTE);
  const body = await parseBody(c, EventBody);
  return c.json(await appendEvent(c.req.param("id"), { actor, seq: body.seq, kind: body.kind, text: body.text, tool: body.tool, targetId: body.target_id }));
});

const FinishBody = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), result_markdown: z.string() }),
  z.object({ status: z.literal("failed"), fail_code: z.string().max(60).optional() }),
]);

// POST /api/mcp/sessions/:id/finish — the final answer (the server writes the reply) or the failure.
router.post("/:id/finish", async (c) => {
  const actor = requireActor(c.get("actor"));
  const body = await parseBody(c, FinishBody);
  const { session, replayed } = await finish(c.req.param("id"), body.status === "completed"
    ? { actor, status: "completed", markdown: body.result_markdown }
    : { actor, status: "failed", failCode: body.fail_code });
  return c.json({ status: session.status, fail_code: session.fail_code, reply_event_id: session.reply_event_id, replayed });
});

export default router;
