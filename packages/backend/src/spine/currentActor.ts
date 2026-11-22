import { isUuid } from "@onden/markdown";
import { event, getWorkspaceId, q, type EventOptions } from "../db.js";
import { db } from "../dbKysely.js";
import { ActorGoneError, UnauthorizedError } from "./actor.js";
import { eventActorType, type ActorCtx, type ActorType, type TokenAccess, type WriteMode } from "../types.js";
import { withEventTransaction } from "./eventTransaction.js";
import { assertCurrentToolAllowed } from "./toolScope.js";
import { SYSTEM_EXTERNAL_ID_SQL } from "./systemActor.js";

/** Reload authority using IDs from trusted authentication or a durable intent.
 * Earlier role/scopes are never grants. Call inside the read snapshot, or AFTER
 * acquiring the workspace event lock and BEFORE any write in that transaction.
 * A temporary session (type 'session') is also refused here once it is ended or past its time (participant_sessions).
 * Returns a new value; never mutates a request's captured actor. Missing actors,
 * workspace mismatch and invalid/mismatched tokens are 401; DB errors propagate.
 * A token held by the built-in System actor is never valid: System cannot be
 * given tokens (services/actors.ts), and one minted before that rule is
 * refused here rather than deleted.
 * Does not authenticate client-supplied IDs or revalidate session cookies.
 * Example: resolveCurrentActor(authenticatedActor, workspaceId). */
export async function resolveCurrentActor(
  identity: { id: string; tokenScope?: { tokenId: string } },
  workspaceId: string,
): Promise<ActorCtx> {
  const tokenId = identity.tokenScope?.tokenId ?? null;
  if (identity.tokenScope && !tokenId) throw new UnauthorizedError();
  const result = await q<{
    id: string; name: string; type: ActorType;
    token_id: string | null;
    allowed_tools: string[] | null; access: TokenAccess | null; write_mode: WriteMode; session_write_mode: WriteMode | null;
    expires_at: Date | null; issued_by: string | null; session_id: string | null;
    temp_session_id: string | null; temp_opened_by: string | null; temp_expires_at: Date | null;
  }>(
    `SELECT a.id, a.name, a.type, a.write_mode, s.write_mode AS session_write_mode,
            t.id AS token_id, t.allowed_tools, t.access, t.expires_at, t.issued_by::text AS issued_by, t.session_id::text AS session_id,
            ps.id::text AS temp_session_id, ps.opened_by::text AS temp_opened_by, ps.expires_at AS temp_expires_at
       FROM actors a
       LEFT JOIN agent_tokens t ON t.id::text=$3 AND t.actor_id=a.id
       LEFT JOIN agent_sessions s ON s.id = t.session_id
       LEFT JOIN participant_sessions ps ON ps.actor_id = a.id
      WHERE a.id::text=$1 AND a.workspace_id=$2
        -- A temporary session is good only while its row says so, judged HERE, at the statement's own time: ended or past its time is
        -- "no such actor" (401), on every request and again under the event lock of every write, so a write that was waiting when the
        -- session ended does not commit. A session never holds a bearer token.
        AND (a.type <> 'session' OR (ps.id IS NOT NULL AND ps.ended_at IS NULL AND ps.expires_at > statement_timestamp() AND $3::text IS NULL))
        AND ($3::text IS NULL OR (t.id IS NOT NULL AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > statement_timestamp())
          AND a.external_id IS DISTINCT FROM ${SYSTEM_EXTERNAL_ID_SQL}))`,
    [identity.id, workspaceId, tokenId],
  );
  const row = result.rows[0];
  if (!row) throw new ActorGoneError();
  const current: ActorCtx = {
    id: row.id, name: row.name, type: row.type,
    ...(row.token_id ? { tokenScope: {
      tokenId: row.token_id, allowedTools: row.allowed_tools, access: row.access ?? "read", expiresAt: row.expires_at,
      // The session's own mode can only tighten the agent's: an api session is 'suggest' (the database
      // requires it) even for an agent set to 'apply'.
      writeMode: row.session_write_mode === "suggest" ? "suggest" : row.write_mode,
      issuedBy: row.issued_by, sessionId: row.session_id,
    } } : {}),
    ...(row.temp_session_id ? { sessionScope: { sessionId: row.temp_session_id, openedBy: row.temp_opened_by!, expiresAt: row.temp_expires_at! } } : {}),
  };
  assertCurrentToolAllowed(current);
  return current;
}

/** The ONE answer to "the identity this request signed in as is gone": every HTTP boundary (httpError.ts apiOnError, the MCP protocol
 *  endpoint routes/mcpProtocol.ts) asks this before it answers an unexpected failure, so a request whose actor was removed — or whose
 *  token was revoked or expired, or whose temporary session ended — while it ran is refused 401 like a credential that never existed,
 *  whichever step tripped over the missing identity (the database's own actor check on an event, migration 071; a foreign key; a
 *  re-read), and no entry needs its own try. The decision is the credential's current state, never the error's shape: a failure of a
 *  request whose identity still resolves stays the failure it is (a 500 stays a 500).
 *  `err` is the failure; ActorGoneError (a re-read that found nothing) is true without a query. Pass only failures the boundary would
 *  otherwise answer as unexpected: a deliberate refusal (403, 404, 409…) is already the right answer.
 *  Example: if (await actorGoneDuring(c.get("actor"), err)) return 401. */
export async function actorGoneDuring(actor: ActorCtx | null | undefined, err: unknown): Promise<boolean> {
  if (err instanceof ActorGoneError) return true;
  if (!actor) return false;
  try {
    await resolveCurrentActor(actor, await getWorkspaceId());
    return false;
  } catch (recheck) {
    // Anything but "no current row" (the database is down, a tool no longer granted) is not this case: the boundary keeps its own answer.
    return recheck instanceof ActorGoneError;
  }
}

/** Append one event attributed to an authenticated request's actor OUTSIDE mutate(): an agent tool call's audit record (allowed, failed or
 *  refused; services/agentTools/registry.ts). The same order as mutate(): the workspace event lock, then resolveCurrentActor, then the insert,
 *  in one transaction (a savepoint when the caller is already in one).
 *  An actor removed — or a token revoked or expired — after authentication but before this write is UnauthorizedError: the request is
 *  answered 401 `{ error: "unauthorized" }` by httpError.ts, the answer a credential that never existed gets at authentication (app.ts), and
 *  nothing is written. Without the re-read the database's own check on domain_events.actor_id (migration 071) refused the insert and the
 *  request answered 500 (PR #1875). The event is attributed to the actor as re-read, never to the request's captured copy.
 *  Example: appendEventAsCurrentActor(ctx.actor, ctx.workspaceId, "AGENT_TOOL_CALLED", "tool", name, { ok: true }, { txMeta }). */
export function appendEventAsCurrentActor(
  actor: ActorCtx, workspaceId: string, eventType: string, targetType: string, targetId: string,
  payload: Record<string, unknown>, options: EventOptions = {},
): Promise<string> {
  return withEventTransaction(workspaceId, async () => {
    const current = await resolveCurrentActor(actor, workspaceId);
    return event(workspaceId, eventType, targetType, targetId, payload, eventActorType(current.type), current.id, options);
  });
}

/** actor_id of a record about work queued by an actor who has since been removed (see signatureForCapturedActor). Not uuid-shaped, so the
 *  database's actor check (migration 071) lets it through, like the other non-actor signatures ("admin-cli"). */
const REMOVED_ACTOR_REF = "removed-actor";

/** Who signs an event that background work writes in the name of an actor id captured when the work was QUEUED — an outbox effect
 *  (an approved tag pack's TAG_IMPORTED), a dispatcher cascade's DISPATCHER_FAILED. Unlike appendEventAsCurrentActor this does not refuse:
 *  the work was authorized when it was queued (or approved), and a job that must still complete must not be lost, crash its runner or be
 *  retried forever because that actor was removed in between. So: an actor that still exists signs as captured; a removed one is replaced
 *  by the system (`actor_type` 'system', REMOVED_ACTOR_REF), and `payloadExtra` carries `removed_actor_id` so the record still ties to that
 *  actor's earlier events. A non-uuid signature ("admin-cli", "system-task-scheduler") is never an actor row and passes as given.
 *  Call it INSIDE the transaction that holds the workspace event lock (withEventTransaction) and write the event in it: removing an actor
 *  takes the same lock (services/actors.ts removeActor → mutate), so the actor cannot vanish between this read and the insert.
 *  Example: const sig = await signatureForCapturedActor(ws, intent.actor_id, "system");
 *           await event(ws, "DISPATCHER_FAILED", "node", id, { ...payload, ...sig.payloadExtra }, sig.actorType, sig.actorId); */
export async function signatureForCapturedActor<T extends string>(workspaceId: string, actorId: string, actorType: T): Promise<{
  actorType: T | "system"; actorId: string; payloadExtra: { removed_actor_id?: string };
}> {
  if (!isUuid(actorId)) return { actorType, actorId, payloadExtra: {} };
  const exists = await db.selectFrom("actors").select("id").where("id", "=", actorId).where("workspace_id", "=", workspaceId).executeTakeFirst();
  return exists
    ? { actorType, actorId, payloadExtra: {} }
    : { actorType: "system", actorId: REMOVED_ACTOR_REF, payloadExtra: { removed_actor_id: actorId } };
}
