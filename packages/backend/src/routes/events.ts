import { Hono } from "hono";
import { holdOpenStream } from "./sseStream.js";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import { restoreEvent, previewEventRestore } from "../services/eventRestore/index.js";
import { revertAttributeConflict } from "../services/attributeWrites.js";
import type { ActorCtx } from "../types.js";
import { requireActor } from "../spine/mutate.js";
import { subscribeRealtimeWithHeartbeat } from "../services/realtime.js";
import { cascadePreview, listEvents } from "../services/eventQuery.js";
import { parseBigintId, parseBody } from "./params.js";
import { StatusError } from "../statusError.js";

type Env = { Variables: { actor: ActorCtx | null } };

const router = new Hono<Env>();

// ── GET /api/events/stream — the blind-tick SSE channel ─────────────────────
//
// PINNED CONTRACT (leak-proof by construction; do not extend the payload):
// the only frames ever written are
//
//   data: {"kind":"changed","latest":<event id>}         a domain event committed
//   data: {"kind":"effects"}                             an outbox row changed status
//   data: {"kind":"membership_changed","epoch":<epoch>}  a permission change bumped
//                                                         the membership epoch
//
//   data: {"kind":"heartbeat"}                           every 25 s, so the client can tell
//                                                         a half-open connection from a quiet one
//
// (EventSource never shows `:` comments.) NO target ids, NO titles, NO event types — a
// tick is a delivery hint, never a fact (the epoch, like `latest`, is a global
// counter that carries no content). Clients react by refetching the existing
// read-policy-filtered endpoints (/api/sync?since, /api/sync/membership,
// /api/events, /api/inbox…), so read policy stays implemented in exactly one
// place. Ticks lost while the socket is DOWN are recovered by the client's
// on-(re)connect handshake (sync + membership reconcile), not by the stream.
// Per-id fine-grained hints are explicitly out of scope (phase 2).
//
// Auth: the global middleware in index.ts already 401s anonymous requests and
// confines bearer tokens to /api/mcp/*; the requireActor() here keeps the gate
// when the router is mounted bare (tests).
//
// Behind nginx the location needs `proxy_buffering off` (see
// docker/nginx/nginx.conf); the X-Accel-Buffering header below is the
// belt-and-braces per-response equivalent.
const HEARTBEAT_MS = 25_000;

router.get("/stream", (c) => {
  requireActor(c.get("actor"));
  return holdOpenStream(c, ({ stream, close, onClose }) => {
    // Writes are chained so a hub tick and a heartbeat can't interleave frames.
    let chain = Promise.resolve();
    const enqueueWrite = (write: () => Promise<unknown>) => {
      chain = chain.then(write).then(
        () => undefined,
        () => close(), // write failure ⇒ client gone
      );
    };

    const unsubscribe = subscribeRealtimeWithHeartbeat(
      (tick) => { enqueueWrite(() => stream.writeSSE({ data: JSON.stringify(tick) })); },
      () => { enqueueWrite(() => stream.writeSSE({ data: JSON.stringify({ kind: "heartbeat" }) })); },
      HEARTBEAT_MS,
    );
    onClose(unsubscribe);

    // First bytes immediately: lets clients (and any proxy) see the stream is
    // live before the first tick. A comment, not a message — carries nothing.
    enqueueWrite(() => stream.write(`: connected\n\n`));
  });
});

router.get("/", async (c) => {
  const workspaceId = await getWorkspaceId();
  const listed = await listEvents(c.get("actor"), workspaceId, {
    since:       c.req.query("since"),
    event_type:  c.req.query("event_type"),
    target_type: c.req.query("target_type"),
    target_id:   c.req.query("target_id"),
    actor_type:  c.req.query("actor_type"),
    actor_id:    c.req.query("actor_id"),
    limit:       c.req.query("limit"),
    deleted:     c.req.query("deleted"),
  });
  if ("error" in listed) return c.json({ error: listed.error }, 400);
  return c.json({ events: listed.events, count: listed.events.length });
});

// ER6: per-entity restore.
//
// POST /api/events/:event_id/restore
//   Body (optional): { force?: boolean }
//   Returns 200 + RestoreResult on success.
//   404 when event missing; 409 for external / already-in-state /
//   patch-conflict; 410 for purged or target-gone; 422 for unsupported.
//
// Idempotent on "already in state" but NOT on re-running a successful
// restore — every successful restore emits a NEW event in the log, so
// running it twice produces an undo-redo oscillation. The UI is expected
// to disable the button after success.
const restoreSchema = z.object({
  force: z.boolean().optional(),
  cascade: z.boolean().optional(),
  as_new_node: z.boolean().optional(),
});

// P1 governance: cascade preview — BEFORE rejecting/restoring an event, show
// what ELSE comes back with it. Walks the triggered_by descendant tree (the
// spine's own provenance) and names each touched target. Read policy: a
// restricted node's existence may be COUNTED but its title must not leak —
// such rows come back redacted. No state change here.
router.get("/:event_id/cascade-preview", async (c) => {
  const eventId = c.req.param("event_id");
  if (parseBigintId(eventId) === null) {
    throw new StatusError(400, "event_id must be a positive integer");
  }
  requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  return c.json(await cascadePreview(c.get("actor"), workspaceId, eventId));
});

// G3: preview before restore. Mirrors SiYuan's side-by-side dialog:
// the frontend shows the user what the restore WOULD produce before
// committing. No state change happens here.
router.get("/:event_id/preview", async (c) => {
  const eventId = c.req.param("event_id");
  if (parseBigintId(eventId) === null) {
    throw new StatusError(400, "event_id must be a positive integer");
  }
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  const result = await previewEventRestore(eventId, { actor, workspaceId });
  if ("code" in result) {
    return c.json({ error: result.code, detail: result.detail }, result.status);
  }
  return c.json(result);
});

router.post("/:event_id/restore", async (c) => {
  const eventId = c.req.param("event_id");
  if (parseBigintId(eventId) === null) {
    throw new StatusError(400, "event_id must be a positive integer");
  }
  const actor = requireActor(c.get("actor"));
  const input = await parseBody(c, restoreSchema, { optional: true });
  const result = await restoreEvent(eventId, {
    force: input.force,
    cascade: input.cascade,
    as_new_node: input.as_new_node,
    actor,
    workspaceId: await getWorkspaceId(),
  });
  if ("code" in result) {
    const reason = "reason" in result && result.reason ? { reason: result.reason } : {};
    return c.json({ error: result.code, detail: result.detail, ...reason }, result.status);
  }
  return c.json(result);
});

// POST /api/events/:event_id/revert-conflict — the inbox's Revert on an
// ATTRIBUTE_CONFLICT: a new attribute write that gives back what the conflict
// overrode (services/attributeWrites.ts revertAttributeConflict). Answers like
// PUT /api/nodes/:id/attributes/:key; 404 for no such (readable) conflict,
// 409 attribute_changed when the attribute was edited since.
router.post("/:event_id/revert-conflict", async (c) => {
  const eventId = c.req.param("event_id");
  if (parseBigintId(eventId) === null) {
    throw new StatusError(400, "event_id must be a positive integer");
  }
  const actor = requireActor(c.get("actor"));
  const { conflict, ...saved } = await revertAttributeConflict({ workspaceId: await getWorkspaceId(), actor, eventId });
  return c.json({ ...saved, ...(conflict ? { conflict } : {}) });
});

export default router;
