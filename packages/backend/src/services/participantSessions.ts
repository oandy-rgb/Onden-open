// Temporary sessions: one person on a computer that is not theirs, for a while (docs/architecture/proposals/sessions-core-2026-11-17.md;
// design B of docs/architecture/proposals/roles-spaces-sessions-2026-11-15.md §5).
//
// A session IS a participant. It is an `actors` row of type 'session' (so it can be a member of spaces) plus one `participant_sessions` row
// (credential, end, limits). Its reach is its space_members rows, nothing else: every question about what it may read or write is answered by the
// rule that answers it for everyone (spine/spaceAccess.ts), which also keeps it no wider than the person who opened it. No check in this file,
// or anywhere, decides what a session may do.
//
//   openTemporarySession   a person (the owner, for now) opens one on chosen spaces; the credential is handed over ONCE
//   listTemporarySessions  the live sessions (spaces, time left; no name: the screen words a session)
//   endTemporarySession    now: the next request, and any write waiting on the workspace lock, is refused
//   endTemporarySessionsOpenedBy   a person is removed: their sessions end with them
//   resolveTemporarySessionActor   a request's credential → the session as an ActorCtx (app.ts), counting the request against its limits
//
// A session is "live" while its row says so: not ended and before its stored time, judged by the database's clock at every request
// (spine/currentActor.ts), so no timer has to run for it to stop. Its credential is 32 random bytes; only the sha-256 is stored; it is never
// logged, never in an event, never in a URL.

import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { bumpMembershipEpoch } from "../db.js";
import { db } from "../dbKysely.js";
import { isWorkspaceOwner, requirePerson } from "../spine/authority.js";
import { consumeFreshProof } from "./freshProof.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { mutate } from "../spine/mutate.js";
import { spaceAccess } from "../spine/spaceAccess.js";
import { UnauthorizedError } from "../spine/actor.js";
import { CodedStatusError } from "../statusError.js";
import type { ActorCtx } from "../types.js";
import { sha256Hex } from "../utils.js";
import { MAX_MEDIA_REQUEST_BYTES, MAX_REQUEST_BYTES } from "@onden/markdown";

/** A session's `actors.name`: no text. A name in the database is in one language and reads as a person's; a session is worded by the screen from its
 *  kind, in the reader's language (as history readers do: services/authorName.ts sends the kind 'session' and no name). Never a device or a place.
 *  Rows made before PR #1856 hold the fixed label 「你（臨時）」; nothing reads it (history readers send no name for a session, member lists leave
 *  sessions out) and it is not rewritten (a migration that rewrites rows is a decision, not part of this batch). */
const SESSION_NAME = "";
const SESSION_CREDENTIAL_PREFIX = "onds_";

/** The longest a session may last, and the most it may be given. A request may ask for less. */
const SESSION_LIMITS = {
  maxMinutes: 24 * 60,
  defaultMinutes: 3 * 60,
  maxRequests: 100_000,
  defaultRequests: 20_000,
  /** Bytes of request bodies (what the session sends: notes, pictures), by their declared length. */
  maxBytes: 1024 * 1024 * 1024,
  defaultBytes: 256 * 1024 * 1024,
  maxSpaces: 50,
} as const;

type SessionSpaceInput = { spaceId: string; permission: "view" | "edit" };
type OpenSessionInput = { spaces: SessionSpaceInput[]; minutes?: number; maxRequests?: number; maxBytes?: number };

type OpenedSession = {
  sessionId: string;
  /** The credential, shown this once. Only its hash is kept. */
  credential: string;
  expiresAt: string;
  spaces: SessionSpaceInput[];
};

type SessionListing = {
  sessionId: string;
  expiresAt: string;
  /** Whole seconds until it stops (never negative; a session at 0 is already not live). */
  secondsLeft: number;
  spaces: Array<{ spaceId: string; name: string; permission: "view" | "edit" }>;
  requestCount: number;
  maxRequests: number;
  canEnd: boolean;
};

class SessionRefused extends CodedStatusError {}

function newCredential(): string {
  return SESSION_CREDENTIAL_PREFIX + randomBytes(32).toString("base64url");
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) throw new SessionRefused(400, "session_limit_invalid", "a session needs a positive time and limits");
  return Math.min(Math.floor(value), max);
}

/** Open a session for `authenticated` (a person who is the workspace owner) on the spaces named: each at most the permission they hold there now.
 *  Spends the fresh confirmation the request carried (`freshProofTicket`, services/freshProof.ts purpose `open_session`) before it reads anything:
 *  a request that only holds the owner's sign-in cannot hand a stranger's computer a way in. */
export async function openTemporarySession(authenticated: ActorCtx, workspaceId: string, input: OpenSessionInput, freshProofTicket: string | null | undefined): Promise<OpenedSession> {
  requirePerson(authenticated, "open_session"); // before any lookup: a token or a session learns nothing
  const minutes = clampInt(input.minutes, SESSION_LIMITS.defaultMinutes, SESSION_LIMITS.maxMinutes);
  const maxRequests = clampInt(input.maxRequests, SESSION_LIMITS.defaultRequests, SESSION_LIMITS.maxRequests);
  const maxBytes = clampInt(input.maxBytes, SESSION_LIMITS.defaultBytes, SESSION_LIMITS.maxBytes);
  const chosen = new Map<string, "view" | "edit">();
  for (const s of input.spaces) chosen.set(s.spaceId, chosen.get(s.spaceId) === "edit" || s.permission === "edit" ? "edit" : "view");
  if (chosen.size === 0 || chosen.size > SESSION_LIMITS.maxSpaces) throw new SessionRefused(400, "session_spaces_invalid", "a session needs between one and fifty spaces");

  await consumeFreshProof(authenticated, "open_session", freshProofTicket);
  const sessionId = randomUUID();
  const sessionActorId = randomUUID();
  const credential = newCredential();
  let expiresAt = "";
  await withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    await mutate({
      actor, workspaceId,
      // The owner only, for now (the guest role and other openers come with the next batch).
      authority: { kind: "principal_admin" },
      affectsMembership: true,
      event: { type: "SESSION_OPENED", targetType: "session", targetId: sessionId, payload: { spaces: chosen.size, minutes } },
      apply: async () => {
        // The person may give a session only what they hold themselves right now: a space they cannot read, or edit when asked for edit, is refused
        // as "not found", the same answer whichever it was.
        for (const [spaceId, permission] of chosen) {
          const access = await spaceAccess(actor, spaceId);
          if (!access || !access.read || (permission === "edit" && !access.write)) throw new SessionRefused(404, "session_space_unavailable", "space not found");
        }
        // Tidy: sessions that ended or ran out leave their membership rows behind (nothing needs them: such a session cannot act); take them with the next opening.
        await sql`DELETE FROM space_members WHERE actor_id IN (SELECT actor_id FROM participant_sessions WHERE workspace_id = ${workspaceId}::uuid AND (ended_at IS NOT NULL OR expires_at <= now()))`.execute(db);
        await db.insertInto("actors").values({ id: sessionActorId, workspace_id: workspaceId, name: SESSION_NAME, type: "session" }).execute();
        const row = await db.insertInto("participant_sessions")
          .values({
            id: sessionId, workspace_id: workspaceId, actor_id: sessionActorId, opened_by: actor.id, credential_hash: sha256Hex(credential),
            expires_at: sql<Date>`now() + make_interval(mins => ${minutes})`, max_requests: maxRequests, max_bytes: String(maxBytes),
          })
          .returning("expires_at").executeTakeFirstOrThrow();
        expiresAt = row.expires_at.toISOString();
        await db.insertInto("space_members")
          .values([...chosen].map(([spaceId, permission]) => ({ space_id: spaceId, actor_id: sessionActorId, permission })))
          .execute();
      },
    });
  });
  return { sessionId, credential, expiresAt, spaces: [...chosen].map(([spaceId, permission]) => ({ spaceId, permission })) };
}

/** The live sessions of the workspace, for the owner; anyone else sees the ones they opened (none, until another role may open). */
export async function listTemporarySessions(authenticated: ActorCtx, workspaceId: string, filter: { spaceId?: string } = {}): Promise<SessionListing[]> {
  requirePerson(authenticated, "list_sessions");
  const actor = await resolveCurrentActor(authenticated, workspaceId);
  const rows = await db.selectFrom("participant_sessions as p")
    .select(["p.id", "p.expires_at", "p.request_count", "p.max_requests", "p.opened_by"])
    .select(sql<number>`GREATEST(0, ceil(extract(epoch FROM p.expires_at - now())))::int`.as("seconds_left"))
    .where("p.workspace_id", "=", workspaceId).where("p.ended_at", "is", null).where(sql<boolean>`p.expires_at > now()`)
    .orderBy("p.created_at").execute();
  const visible = (await isWorkspaceOwner(actor)) ? rows : rows.filter((r) => r.opened_by === actor.id);
  const memberships = visible.length === 0 ? [] : await db.selectFrom("participant_sessions as p")
    .innerJoin("space_members as m", "m.actor_id", "p.actor_id").innerJoin("spaces as s", "s.id", "m.space_id")
    .select(["p.id as session_id", "m.space_id", "s.name", "m.permission"])
    .where("p.id", "in", visible.map((r) => r.id)).where("s.deleted_at", "is", null).orderBy("s.name").orderBy("s.id").execute();
  const out: SessionListing[] = [];
  for (const r of visible) {
    const spaces = memberships.filter((m) => m.session_id === r.id);
    if (filter.spaceId && !spaces.some((s) => s.space_id === filter.spaceId)) continue;
    out.push({
      sessionId: r.id, expiresAt: r.expires_at.toISOString(), secondsLeft: r.seconds_left,
      spaces: spaces.map((s) => ({ spaceId: s.space_id, name: s.name, permission: s.permission as "view" | "edit" })),
      requestCount: Number(r.request_count), maxRequests: r.max_requests, canEnd: true,
    });
  }
  return out;
}

/** End a session now. The session's membership goes with it, and the next request of the session is refused; a write of the session that is waiting
 *  for the workspace lock when this commits is refused when it gets the lock (spine/currentActor.ts), so nothing it does is committed after the end.
 *  Ending an ended session is a no-op that says so. */
export async function endTemporarySession(authenticated: ActorCtx, workspaceId: string, sessionId: string): Promise<{ ended: boolean }> {
  requirePerson(authenticated, "end_session");
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    return mutate({
      actor, workspaceId,
      authority: { kind: "principal_admin" },
      affectsMembership: true,
      event: { type: "SESSION_ENDED", targetType: "session", targetId: sessionId, payload: { reason: "ended" } },
      apply: async () => {
        const row = await db.selectFrom("participant_sessions").select(["actor_id", "ended_at"])
          .where("id", "=", sessionId).where("workspace_id", "=", workspaceId).forUpdate().executeTakeFirst();
        if (!row) throw new SessionRefused(404, "session_not_found", "session not found");
        if (row.ended_at) return { ended: false };
        await db.updateTable("participant_sessions").set({ ended_at: sql<Date>`now()` }).where("id", "=", sessionId).execute();
        await db.deleteFrom("space_members").where("actor_id", "=", row.actor_id).execute();
        return { ended: true };
      },
    });
  });
}

/** A person is leaving the workspace: end every live session they opened, in the removal's own transaction (call inside its mutate(), like
 *  agentTokens.revokeTokensIssuedBy). Returns how many ended. */
export async function endTemporarySessionsOpenedBy(workspaceId: string, openerId: string): Promise<number> {
  const ended = await db.updateTable("participant_sessions").set({ ended_at: sql<Date>`now()` })
    .where("workspace_id", "=", workspaceId).where("opened_by", "=", openerId).where("ended_at", "is", null).returning("actor_id").execute();
  if (ended.length > 0) {
    await db.deleteFrom("space_members").where("actor_id", "in", ended.map((r) => r.actor_id)).execute();
    await bumpMembershipEpoch(workspaceId);
  }
  return ended.length;
}

/** The session behind a request's credential, as an actor — or null when the credential is not a session's, or the session is no longer live (ended,
 *  past its time, unknown: one answer). Counts the request against the session's limit in the same statement that checks it is live, so a session cannot
 *  spend past it by racing; a live session out of requests or bytes is refused with its own code. The bytes of a request's body are charged once the
 *  server has READ them (chargeTemporarySessionBytes), never by what a header says. Response size is not metered. */
export async function resolveTemporarySessionActor(rawCredential: string, workspaceId: string): Promise<ActorCtx | null> {
  if (!rawCredential.startsWith(SESSION_CREDENTIAL_PREFIX)) return null;
  const hash = sha256Hex(rawCredential);
  const used = await sql<{ actor_id: string }>`
    UPDATE participant_sessions SET request_count = request_count + 1, last_used_at = now()
     WHERE credential_hash = ${hash} AND workspace_id = ${workspaceId}::uuid AND ended_at IS NULL AND expires_at > now()
       AND request_count < max_requests AND byte_count < max_bytes
    RETURNING actor_id::text AS actor_id`.execute(db);
  const actorId = used.rows[0]?.actor_id;
  if (!actorId) {
    const live = await sql`SELECT 1 FROM participant_sessions WHERE credential_hash = ${hash} AND workspace_id = ${workspaceId}::uuid AND ended_at IS NULL AND expires_at > now()`.execute(db);
    if (live.rows.length > 0) throw new SessionRefused(403, "session_limit_reached", "this session has used what it was given");
    return null;
  }
  try {
    return await resolveCurrentActor({ id: actorId }, workspaceId);
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

/** The most one request body of a temporary session may hold: what nginx lets any person's request carry on the same path (docker/nginx/nginx.conf:
 *  MAX_MEDIA_REQUEST_BYTES on the upload route, the general MAX_REQUEST_BYTES elsewhere), so a session is never given a bigger body than its person. */
function temporarySessionBodyCap(path: string): number {
  return path === "/api/media" ? MAX_MEDIA_REQUEST_BYTES : MAX_REQUEST_BYTES;
}

/** The body of a write by session `sessionId`, read into memory and counted AS IT IS READ, never trusting a header, so the server holds at most
 *  min(the request cap, what the session has left) bytes (+ one chunk) however large the body is declared or streamed:
 *    - a declared length (Content-Length) over the request cap is refused 413 `body_too_large`, over what the session has left 403
 *      `session_limit_reached`, both BEFORE a byte is read; with no declared length the stream is counted and cancelled at the same two limits;
 *    - what was read is charged in one conditional UPDATE (`byte_count + n <= max_bytes`), so concurrent requests cannot spend past the limit either.
 *  A refused request is not served and writes nothing. Returns the bytes (null for a request with no body); the caller hands them on to the route.
 *  The limit is exact: a session never overshoots (it used to by one body). Response size is not metered. */
export async function readTemporarySessionBody(request: Request, sessionId: string, path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return null;
  const cap = temporarySessionBodyCap(path);
  const left = await sql<{ left: string }>`SELECT (max_bytes - byte_count)::text AS left FROM participant_sessions WHERE id = ${sessionId}::uuid`.execute(db);
  const remaining = Number(left.rows[0]?.left ?? 0);
  const refuse = (read: number) => {
    if (read > cap) throw new SessionRefused(413, "body_too_large", "the request body is larger than a request may be");
    if (read > remaining) throw new SessionRefused(403, "session_limit_reached", "this session has used what it was given");
  };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 0) refuse(declared);
  const chunks: Uint8Array[] = [];
  let read = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      refuse(read); // the first chunk that passes a limit stops the read: the rest is never taken in
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (read === 0) return null;
  await chargeTemporarySessionBytes(sessionId, read);
  const body = new Uint8Array(new ArrayBuffer(read));
  let at = 0;
  for (const chunk of chunks) { body.set(chunk, at); at += chunk.byteLength; }
  return body;
}

/** Charge `bytesRead` body bytes to the session in one conditional UPDATE (`byte_count + n <= max_bytes`): refused (403 session_limit_reached) when they do
 *  not fit, so concurrent requests cannot spend past the limit between the check and the charge. */
async function chargeTemporarySessionBytes(sessionId: string, bytesRead: number): Promise<void> {
  const charged = await sql`UPDATE participant_sessions SET byte_count = byte_count + ${bytesRead}
                             WHERE id = ${sessionId}::uuid AND byte_count + ${bytesRead} <= max_bytes RETURNING 1`.execute(db);
  if (charged.rows.length === 0) throw new SessionRefused(403, "session_limit_reached", "this session has used what it was given");
}
