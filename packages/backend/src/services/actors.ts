// Permission administration (depth audit D9): workspace members (actors) and
// the bearer tokens they hold. Every operation here is permission-DEFINING and
// owns its whole rule set — the principal gate, validation, the existence
// checks and the spine mutate() — so routes/actors.ts only parses and responds.
// Moved verbatim from the route; statuses and bodies are unchanged.
//
// These are permission-DEFINING operations, reserved to the workspace principal
// (the owner via session or native app) — NEVER a delegated bearer token, even
// an admin-role one (a token that could mint tokens or change actors would let
// an agent escalate past whoever granted it). The spine's `principal_admin`
// authority enforces this by construction inside every mutate() below; this
// early gate runs the SAME check first, before any existence/validation lookup,
// so a non-principal can't probe actor/token ids via 404-vs-403 either.
//
// The signal is `tokenScope` (came from a bearer token), NOT actor.type — the
// native-app owner is a type='agent' System actor, so gating on type would lock
// the human out of their own permission administration.
// Actor + token mutations are permission changes — the highest-stakes writes in
// the system (granting/revoking what an agent can do). They flow through the
// spine's mutate() like every other write, which gives them, by construction:
// an admin authority check, an attributed ACTOR_*/TOKEN_* domain event (so every
// grant/revoke leaves an audit trail), and event+row atomicity. Token plaintext
// and hashes NEVER enter an event payload — only metadata (id, name, scope).
//
// Errors from the spine (missing actor → 401, principal/role denial → 403) map
// in the central onError handler (src/index.ts). The early notOwner
// gate still catches non-principals before any lookup, so 404-vs-403 probing
// stays closed; the in-mutate backstop only fires behind it.


import { registeredPersonalTables } from "./moduleCatalog.js";
import { pool, q, getWorkspaceId, withTransaction } from "../db.js";
import { sqlIdentifier } from "../sqlText.js";
import type { ActorCtx, ActorType, TokenAccess } from "../types.js";
import { mutate, requireActor, UnauthorizedError } from "../spine/mutate.js";
import { isSessionActorType, isWorkspaceOwner } from "../spine/authority.js";
import { createToken, revokeToken, setTokenAccess, revokeTokensIssuedBy } from "./agentTokens.js";
import { endTemporarySessionsOpenedBy } from "./participantSessions.js";
import { TOKEN_ACCESS_LEVELS, isTokenAccess, toolsForAccess } from "./agentTools/index.js";
import { recordMemberRemoval, liftMemberRemoval, endUserSessions, isMemberRemoved } from "./memberRemovals.js";
import {
  normalizeInviteEmail, mintInviteToken, checkInviteToken, inviteRefusal, hashInviteToken, InviteError,
} from "./actorInvites.js";
import { nativeBypassEnabled, nativeBypassState } from "../nativeBypass.js";
import { SYSTEM_EXTERNAL_ID_SQL } from "../spine/systemActor.js";
import { orphanPersonalSpace } from "./spaces.js";

/** A refusal with the exact status and body the API answers. */
export class ActorAdminError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly body: Record<string, unknown>) {
    super(String(body.error));
    this.name = "ActorAdminError";
  }
}

const OWNER_ONLY = "permission administration is reserved to the workspace owner";

/** The authenticated principal, or ActorAdminError(403 owner_only) — run FIRST,
 *  before any lookup, so a non-principal can't probe ids via 404-vs-403. */
async function principal(authenticated: ActorCtx | null, detail = OWNER_ONLY): Promise<ActorCtx> {
  const actor = requireActor(authenticated);
  if (!(await isWorkspaceOwner(actor))) throw new ActorAdminError(403, { error: "owner_only", detail });
  return actor;
}

/** The built-in System actor (external_id 'system'): the account the native
 *  bypass signs in as, for local development and tests. It never holds a
 *  token (an owner-level credential nobody needs), and while the bypass is on
 *  it cannot be removed; in production (bypass forced off) the owner may. */
async function isSystemActor(workspaceId: string, id: string): Promise<boolean> {
  // q(), not the pool: inside a transaction (setUpAi) the actor may be one this transaction has just made.
  const r = await q(
    `SELECT 1 FROM actors WHERE workspace_id = $1 AND id::text = $2 AND external_id = ${SYSTEM_EXTERNAL_ID_SQL}`,
    [workspaceId, id],
  );
  return r.rows.length > 0;
}

const SYSTEM_NO_TOKENS = new ActorAdminError(403, {
  error: "system_actor_no_tokens",
  detail: "the built-in System account cannot hold tokens",
});

async function requireMember(workspaceId: string, id: string, error = "actor not found"): Promise<void> {
  // q(), not the pool: another connection does not see an actor made earlier in the caller's transaction
  // (setUpAi makes the AI and its connection code together; on PGlite's one connection this never showed).
  const exists = await q(`SELECT 1 FROM actors WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  if (!exists.rows[0]) throw new ActorAdminError(404, { error });
}

/** Fields the owner/member change removed. A client that still sends one
 *  would believe it had granted something, so it is refused instead of being
 *  ignored (400 with the replacement named). */
function refuseRemovedFields(body: Record<string, unknown>, removed: Record<string, { error: string; detail: string }>): void {
  for (const [field, refusal] of Object.entries(removed)) {
    if (field in body) throw new ActorAdminError(400, refusal);
  }
}

const ROLE_REMOVED = { error: "role_removed", detail: "members have no workspace role; the owner decides what a member may do in each space (Spaces and members)" };

// The actor roster IS permission-administration data — names, types, roles and
// external_ids of every human/agent in the workspace. Disclosing it to a
// low-privilege actor (viewer, or any bearer token) hands an attacker the
// principal/admin target list. List is therefore reserved to the workspace
// owner, the same `notOwner` gate the actor/token MUTATIONS use, so a
// non-principal can neither read nor write the roster.
export async function listActors(authenticated: ActorCtx | null) {
  await principal(authenticated, "the actor roster is reserved to the workspace owner");
  const workspaceId = await getWorkspaceId();
  // is_owner marks the one row that is the workspace owner.
  const result = await pool.query(
    `SELECT a.id, a.name, a.type, a.external_id, a.created_at, a.invite_email,
            CASE WHEN a.external_id IS NULL THEN a.invite_expires_at END AS invite_expires_at,
            (a.type = 'human' AND a.external_id IS NULL AND a.invite_email IS NOT NULL) AS invite_pending,
            (a.id = w.owner_actor_id) IS TRUE AS is_owner,
            (a.external_id = ${SYSTEM_EXTERNAL_ID_SQL}) IS TRUE AS is_system
       FROM actors a JOIN workspaces w ON w.id = a.workspace_id
      WHERE a.workspace_id = $1 AND a.type <> 'session' ORDER BY a.created_at ASC`,
    [workspaceId],
  );
  // The System row carries the native bypass state, for the roster to say
  // whether anyone can sign in as it: "on" (tests / dev with
  // ALLOW_NATIVE_BYPASS=1), "off_production" (forced off) or "off".
  const nativeBypass = nativeBypassState();
  return result.rows.map((row: { is_system: boolean }) => row.is_system ? { ...row, native_bypass: nativeBypass } : row);
}

export type NewActor = { name: string; type: "human" | "agent"; external_id?: string; email?: string };

/** The one-time invite link, as the owner sees it ONCE (on invite and on
 *  regenerate): the token, the app path that carries it, and its expiry. The
 *  client prefixes the path with the app's own address. Never stored or
 *  returned again — only its hash is kept. */
export type InviteLink = { invite_token: string; invite_path: string; invite_expires_at: string };

const inviteLink = (token: string, expiresAt: Date): InviteLink => ({
  invite_token: token,
  invite_path: `/?invite=${encodeURIComponent(token)}`,
  invite_expires_at: expiresAt.toISOString(),
});

/** A unique-index race on the pending-invite address (two owners' tabs
 *  inviting one email at once) is the same refusal as the pre-check's. */
function isPendingInviteRace(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  return err?.code === "23505" && err.constraint === "actors_pending_invite_email_uq";
}

/** Add a member. A person is an INVITE (audit D110): the row waits,
 *  external_id NULL, until a sign-in presents the one-time invite link
 *  returned here AND has the invited email; it then claims the row with the
 *  spaces the owner gives it (actorForSession). A new member is in no shared
 *  space until the owner adds them (view by default). A human added by external_id (an account the owner
 *  names directly) needs no email or link and lifts their earlier removal.
 *  Agents are made by name. `readInput` parses the request body; it runs only
 *  after the principal gate. */
export async function createActor(authenticated: ActorCtx | null, readInput: () => Promise<NewActor>) {
  const actor = await principal(authenticated);
  const workspaceId = await getWorkspaceId();
  // The body is read after the gate: a non-owner gets 403 whatever they sent.
  const input = await readInput();
  refuseRemovedFields(input as Record<string, unknown>, { role: ROLE_REMOVED });
  // Without these the INSERT fails on a NOT NULL column and the caller sees a 500 for a bad request.
  if (typeof input.name !== "string" || input.name.trim() === "") throw new ActorAdminError(400, { error: "name_required" });
  if (input.type !== "human" && input.type !== "agent") throw new ActorAdminError(400, { error: "invalid_actor_type" });
  const inviteEmail = input.type === "human" && !input.external_id ? await assertInviteEmail(workspaceId, input.email) : null;
  const link = inviteEmail ? mintInviteToken() : null;
  try {
    const created = await mutate({
      actor,
      workspaceId,
      authority: { kind: "principal_admin" },
      event: {
        type: "ACTOR_CREATED",
        targetType: "actor",
        targetId: (r: { id: string }) => r.id,
        // Neither the address nor the link enters the append-only log.
        payload: { name: input.name, actor_type: input.type, ...(inviteEmail ? { invited: true } : {}) },
      },
      timing: "after", // actor id is DB-generated
      apply: async () => {
        if (input.type === "human" && input.external_id) await liftMemberRemoval(workspaceId, input.external_id);
        const res = await q<{ id: string }>(
          // A new agent starts in suggest mode: its note edits are suggestions a
          // person accepts. (Agents made before suggestions keep writing directly.)
          `INSERT INTO actors (workspace_id, name, type, external_id, invite_email, invite_token_hash, invite_expires_at, write_mode)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $3::text = 'agent' THEN 'suggest' ELSE 'apply' END)
           RETURNING id, name, type, external_id, invite_email, invite_expires_at, created_at,
                     (type = 'human' AND external_id IS NULL AND invite_email IS NOT NULL) AS invite_pending`,
          [workspaceId, input.name, input.type, input.external_id ?? null, inviteEmail, link?.hash ?? null, link?.expiresAt ?? null],
        );
        return res.rows[0];
      },
    });
    return link ? { ...created, ...inviteLink(link.token, link.expiresAt) } : created;
  } catch (e) {
    if (isPendingInviteRace(e)) throw new ActorAdminError(409, { error: "invite_email_taken" });
    throw e;
  }
}

/** Make a new invite link for a person who has not signed in yet. The old
 *  link stops working at once (its hash is replaced) and the new one is
 *  valid for INVITE_TTL_DAYS. Returned once, like on invite. */
export async function regenerateInvite(authenticated: ActorCtx | null, id: string): Promise<InviteLink> {
  const actor = await principal(authenticated);
  const workspaceId = await getWorkspaceId();
  await requireMember(workspaceId, id);
  const pending = await pool.query(
    `SELECT 1 FROM actors WHERE workspace_id = $1 AND id = $2 AND type = 'human' AND external_id IS NULL AND invite_email IS NOT NULL`,
    [workspaceId, id],
  );
  if (!pending.rows[0]) throw new ActorAdminError(409, { error: "invite_not_pending", detail: "only a person who has not signed in yet has an invite link" });
  const link = mintInviteToken();
  await mutate({
    actor,
    workspaceId,
    authority: { kind: "principal_admin" },
    event: { type: "ACTOR_INVITE_RENEWED", targetType: "actor", targetId: id, payload: { expires_at: link.expiresAt.toISOString() } },
    apply: async () => {
      // Re-checked in the write: a claim that landed meanwhile keeps its row.
      const res = await q(
        `UPDATE actors SET invite_token_hash = $3, invite_expires_at = $4, invite_used_at = NULL
          WHERE workspace_id = $1 AND id = $2 AND external_id IS NULL AND invite_email IS NOT NULL`,
        [workspaceId, id, link.hash, link.expiresAt],
      );
      if (res.rowCount === 0) throw new ActorAdminError(409, { error: "invite_not_pending" });
    },
  });
  return inviteLink(link.token, link.expiresAt);
}

/** The invite's address, normalised: required, shaped like an email, not
 *  already waiting on another invite here, not a member's already. */
async function assertInviteEmail(workspaceId: string, raw: unknown): Promise<string> {
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
    throw new ActorAdminError(400, { error: "email_required", detail: "a person is invited by email" });
  }
  const email = normalizeInviteEmail(raw);
  if (!email) throw new ActorAdminError(400, { error: "invalid_email" });
  const pending = await pool.query(
    `SELECT 1 FROM actors WHERE workspace_id = $1 AND type = 'human' AND external_id IS NULL AND invite_email = $2`,
    [workspaceId, email],
  );
  if (pending.rows[0]) throw new ActorAdminError(409, { error: "invite_email_taken" });
  // Someone already signed in with this address is already a member here: an
  // invite for them would never be claimed. (The auth tables exist once the
  // auth library has migrated; a bare schema.sql database has none yet.)
  const member = await pool.query(
    `SELECT 1 WHERE to_regclass('public."user"') IS NOT NULL`,
  );
  if (member.rows[0]) {
    const existing = await pool.query(
      `SELECT 1 FROM actors a JOIN "user" u ON u.id = a.external_id
        WHERE a.workspace_id = $1 AND lower(btrim(u.email)) = $2 LIMIT 1`,
      [workspaceId, email],
    );
    if (existing.rows[0]) throw new ActorAdminError(409, { error: "already_member" });
  }
  return email;
}

/** The authenticated login a request carries (the auth library's session
 *  user), as much of it as resolving the actor needs. */
export type SessionUser = { id: string; name?: string | null; email?: string | null; emailVerified?: boolean | null };
type ActorRow = { id: string; name: string; type: ActorType };

const sessionName = (user: SessionUser): string => (user.name?.trim() || user.email?.trim() || "Member");

/** The workspace member a signed-in login acts as (moved from index.ts,
 *  audit D110). In order:
 *    1. the actor already linked to this login (external_id);
 *    2. with `inviteToken` (POST /api/invites/claim only): the invite that
 *       one-time link names CLAIMS for this login — only when the link is
 *       valid, unused and unexpired AND the login's email is the invited one.
 *       It keeps the spaces the owner set (ACTOR_CLAIMED) and spends the
 *       link. Any refusal throws InviteError; it never falls through to
 *       making a member;
 *    3. otherwise a new member — the first human of an empty workspace as
 *       its owner (the database makes it so, actors_sync_spaces), everyone
 *       later a plain member in no shared space (ACTOR_CREATED). A login whose
 *       email matches an invite but brings no link lands here too: the email
 *       alone claims nothing.
 *  A member the owner removed stays out (membership_removed) unless the owner
 *  invited them again and they use that link. The login's name is copied only
 *  when the actor is created or claimed: a rename in Users & Agents sticks.
 *
 *  With a link, a login that already has a member here gets
 *  InviteError(409 already_member) — unless that member IS the invite it
 *  claimed (a retried claim), which returns it.
 *
 *  Email verification: this server sends no verification mail, so an
 *  email/password account is never "verified"; the link is what proves the
 *  owner meant this person, the email match only keeps a forwarded link from
 *  working for another address.
 *
 *  Runs in the actor middleware, before the idempotency middleware makes a
 *  request's Idempotency-Key ambient (index.ts), so these mutate()s never
 *  claim the key meant for the request's own write. */
export async function actorForSession(
  user: SessionUser, workspaceId: string, opts: { inviteToken?: string | null } = {},
): Promise<ActorCtx> {
  const byLogin = `SELECT id, name, type FROM actors WHERE workspace_id = $1 AND external_id = $2`;
  const inviteToken = opts.inviteToken ?? null; // "" = a claim that brought no link (refused)
  const alreadyMember = async (row: ActorRow): Promise<ActorCtx> => {
    if (inviteToken === null) return row;
    const own = await q(`SELECT 1 FROM actors WHERE id = $1 AND invite_token_hash = $2`, [row.id, hashInviteToken(inviteToken)]);
    if (own.rows[0]) return row;
    throw new InviteError("already_member", 409);
  };
  const existing = await pool.query<ActorRow>(byLogin, [workspaceId, user.id]);
  if (existing.rows[0]) return alreadyMember(existing.rows[0]);
  // Audit #5: check-then-insert raced — two concurrent FIRST logins could both
  // see "no humans yet" and both become admin (and insert duplicate actor rows
  // for the same external_id), and two tabs could both claim one invite. A
  // per-workspace advisory xact lock serializes the bootstrap path; the
  // re-check inside the lock handles the loser.
  return withTransaction(async () => {
    await q(`SELECT pg_advisory_xact_lock(hashtext('actor-bootstrap:' || $1))`, [workspaceId]);
    const raced = await q<ActorRow>(byLogin, [workspaceId, user.id]);
    if (raced.rows[0]) return alreadyMember(raced.rows[0]);
    const name = sessionName(user);

    if (inviteToken !== null) {
      const check = await checkInviteToken(inviteToken, user.email, { workspaceId, forUpdate: true });
      if (!check.ok) throw inviteRefusal(check.refusal);
      const inviteId = check.invite.id;
      // The owner invited this person: an earlier removal of this login is
      // lifted (in apply), as when the owner adds an account back by id. The
      // member themself acts (their first sign-in), holding the owner's link —
      // nothing for a permission to gate. No address or link in the log.
      return mutate({
        actor: { id: inviteId, name, type: "human" },
        workspaceId,
        authority: { kind: "open", why: "a login with the owner's invite link and the invited email claims it" },
        event: { type: "ACTOR_CLAIMED", targetType: "actor", targetId: inviteId, payload: { name } },
        apply: async () => {
          await liftMemberRemoval(workspaceId, user.id);
          const claimed = await q<ActorRow>(
            `UPDATE actors SET external_id = $2, name = $3, invite_used_at = now()
              WHERE id = $1 RETURNING id, name, type`,
            [inviteId, user.id, name],
          );
          return claimed.rows[0]!;
        },
      });
    }

    // A member the owner removed stays removed: their still-valid login must
    // not re-create the actor (GAP-237). Read under the bootstrap lock, so a
    // concurrent removal is seen either as the actor row above or as this.
    if (await isMemberRemoved(workspaceId, user.id)) throw new UnauthorizedError("membership_removed");
    const isFirst = (await q(`SELECT 1 FROM actors WHERE workspace_id = $1 AND type = 'human' LIMIT 1`, [workspaceId])).rows.length === 0;
    // Default-deny for self-signup (governance): only the FIRST human to land on
    // an empty workspace becomes its owner (the insert trigger sets
    // workspaces.owner_actor_id). Every later self-signup is a plain member in
    // no shared space; the owner adds them to spaces, or invites the email
    // beforehand with the spaces they want.
    const created = await q<ActorRow>(
      `INSERT INTO actors (workspace_id, name, type, external_id)
       VALUES ($1, $2, 'human', $3)
       RETURNING id, name, type`,
      [workspaceId, name, user.id],
    );
    const row = created.rows[0]!;
    // Recorded as the new member's own act. The row is inserted first because
    // the spine reloads its actor from the database before anything else; the
    // event still commits with it (same transaction).
    return mutate({
      actor: row,
      workspaceId,
      authority: { kind: "open", why: "a first sign-in makes its own member" },
      event: { type: "ACTOR_CREATED", targetType: "actor", targetId: row.id, payload: { name, actor_type: "human", signup: true, ...(isFirst ? { owner: true } : {}) } },
      apply: async () => row,
    });
  });
}

/** Rename a member. `readInput` runs only after the principal gate. */
export async function updateActor(authenticated: ActorCtx | null, id: string, readInput: () => Promise<{ name?: string }>) {
  const actor = await principal(authenticated);
  const workspaceId = await getWorkspaceId();
  const input = await readInput();
  refuseRemovedFields(input as Record<string, unknown>, { role: ROLE_REMOVED });
  // Confirm the actor exists in this workspace before emitting an UPDATE event.
  await requireMember(workspaceId, id, "not found");
  const updated = await mutate({
    actor,
    workspaceId,
    authority: { kind: "principal_admin" },
    event: {
      type: "ACTOR_UPDATED",
      targetType: "actor",
      targetId: id,
      payload: { ...(input.name != null ? { name: input.name } : {}) },
    },
    apply: async () => {
      const res = await q<Record<string, unknown>>(
        `UPDATE actors SET name = COALESCE($3, name)
         WHERE workspace_id = $1 AND id = $2
         RETURNING id, name, type, external_id, created_at`,
        [workspaceId, id, input.name ?? null],
      );
      return res.rows[0];
    },
  });
  return updated;
}

/** Mint a bearer token for a member. The plaintext is returned ONCE. */
export type TokenInput = {
  name?: string;
  /** read: look things up. write: also edit, in the spaces its agent edits. */
  access?: TokenAccess;
  expires_at?: string | null;
};

const TOKEN_FIELDS_REMOVED: Record<string, { error: string; detail: string }> = {
  read_space_ids: { error: "token_scope_removed", detail: "a token reaches the spaces its agent is a member of; add or remove the agent in Spaces and members" },
  write_space_ids: { error: "token_scope_removed", detail: "a token reaches the spaces its agent is a member of; add or remove the agent in Spaces and members" },
  allowed_tools: { error: "custom_tools_removed", detail: `a token is read or write: pass access (${TOKEN_ACCESS_LEVELS.join(" | ")})` },
  template: { error: "custom_tools_removed", detail: `a token is read or write: pass access (${TOKEN_ACCESS_LEVELS.join(" | ")})` },
  role: ROLE_REMOVED,
};

function requireAccess(body: TokenInput): TokenAccess {
  if (!isTokenAccess(body.access)) {
    throw new ActorAdminError(400, { error: "invalid_access", detail: { allowed: [...TOKEN_ACCESS_LEVELS] } });
  }
  return body.access;
}

export async function mintToken(authenticated: ActorCtx | null, id: string, body: TokenInput) {
  const actor = await principal(authenticated);
  const workspaceId = await getWorkspaceId();
  // Confirm the actor belongs to this workspace before minting
  await requireMember(workspaceId, id);
  if (await isSystemActor(workspaceId, id)) throw SYSTEM_NO_TOKENS;
  refuseRemovedFields(body as Record<string, unknown>, TOKEN_FIELDS_REMOVED);
  // The access expands server-side to a vetted tool list that the minted token
  // stores, so later registry growth never widens an existing token.
  const access = requireAccess(body);
  const allowedTools = toolsForAccess(access);

  const minted = await mutate({
    actor,
    workspaceId,
    authority: { kind: "principal_admin" },
    event: {
      type: "TOKEN_CREATED",
      targetType: "token",
      targetId: (r: { id: string }) => r.id,
      // Metadata only — never the plaintext or hash.
      payload: { actor_id: id, name: body.name ?? "", access, allowed_tools: allowedTools, expires_at: body.expires_at ?? null },
    },
    timing: "after", // token id is DB-generated by createToken
    apply: async () =>
      createToken(id, {
        name: body.name ?? "",
        access,
        allowedTools,
        expiresAt: body.expires_at ?? null,
        issuedBy: actor.id,
      }),
  });
  return {
    id: minted.id,
    token: minted.plaintext,
    name: body.name ?? "",
    access,
    allowed_tools: allowedTools,
    expires_at: body.expires_at ?? null,
  };
}

// List token metadata (never plaintext). Includes access so the UI can render
// what each token can do. Reserved to the workspace owner via the SAME
// notOwner gate as the token MUTATIONS — token metadata is
// permission-administration data; gate it like one.
export async function listTokens(authenticated: ActorCtx | null, id: string) {
  await principal(authenticated);
  const workspaceId = await getWorkspaceId();
  await requireMember(workspaceId, id);
  const res = await pool.query(
    `SELECT id, name, created_at, last_used_at, access, allowed_tools, expires_at, revoked_at
     FROM agent_tokens WHERE actor_id = $1 ORDER BY created_at DESC`,
    [id],
  );
  return res.rows;
}

// Change a live token between read and write in place. Tokens used to be
// mint-once (revoke + re-mint hands out a NEW secret and breaks any agent still
// holding the old one); this keeps the secret. The tool list is expanded again
// from the new access — which is also how a token minted with "every tool"
// becomes a standard one. Permission-DEFINING → principal_admin only, like
// mint/revoke. The plaintext is never reissued (only the hash is stored).
export async function changeTokenAccess(
  authenticated: ActorCtx | null, id: string, tokenId: string, body: Pick<TokenInput, "access">,
) {
  const actor = await principal(authenticated);
  const workspaceId = await getWorkspaceId();
  await requireMember(workspaceId, id);
  if (await isSystemActor(workspaceId, id)) throw SYSTEM_NO_TOKENS;
  refuseRemovedFields(body as Record<string, unknown>, TOKEN_FIELDS_REMOVED);
  const to = requireAccess(body);
  const allowedTools = toolsForAccess(to);

  // Confirm the token is live (exists + not revoked) before emitting an event —
  // changing a phantom/revoked token must not write a spurious audit event,
  // and a revoked token must stay revoked (this is not a back-door revive).
  const live = await pool.query<{ access: TokenAccess }>(
    `SELECT access FROM agent_tokens WHERE id = $1 AND actor_id = $2 AND revoked_at IS NULL`,
    [tokenId, id],
  );
  if (!live.rows[0]) throw new ActorAdminError(404, { error: "token not found" });
  const from = live.rows[0].access;

  await mutate({
    actor,
    workspaceId,
    authority: { kind: "principal_admin" },
    event: {
      type: "TOKEN_ACCESS_CHANGED",
      targetType: "token",
      targetId: tokenId,
      payload: { actor_id: id, from, to },
    },
    apply: async () => setTokenAccess(id, tokenId, { access: to, allowedTools, issuedBy: actor.id }),
  });

  const updated = await pool.query(
    `SELECT id, name, created_at, last_used_at, access, allowed_tools, expires_at, revoked_at
     FROM agent_tokens WHERE id = $1 AND actor_id = $2`,
    [tokenId, id],
  );
  return updated.rows[0];
}

// P1 治理 cost stats: what has this actor actually been DOING — tool calls
// (ok/failed/total duration) and domain-event counts, windowed. Reserved to the
// workspace owner via the same notOwner gate as the token list (a
// bearer token must not read another actor's governance meter). Counts come
// straight off domain_events: the audit trail IS the meter, no second
// bookkeeping to drift.
export async function actorStats(authenticated: ActorCtx | null, id: string, days: number) {
  await principal(authenticated);
  const workspaceId = await getWorkspaceId();
  await requireMember(workspaceId, id);

  const tools = await pool.query<{ tool: string; ok: string; failed: string; total_ms: string }>(
    `SELECT target_id AS tool,
            count(*) FILTER (WHERE event_type = 'AGENT_TOOL_CALLED') AS ok,
            count(*) FILTER (WHERE event_type = 'AGENT_TOOL_FAILED') AS failed,
            COALESCE(sum((payload->>'duration_ms')::bigint), 0) AS total_ms
       FROM domain_events
      WHERE workspace_id = $1 AND actor_id = $2 AND target_type = 'tool'
        AND created_at > now() - make_interval(days => $3)
      GROUP BY target_id
      ORDER BY count(*) DESC`,
    [workspaceId, id, days],
  );
  const changes = await pool.query<{ event_type: string; count: string }>(
    `SELECT event_type, count(*) AS count
       FROM domain_events
      WHERE workspace_id = $1 AND actor_id = $2 AND target_type <> 'tool'
        AND created_at > now() - make_interval(days => $3)
      GROUP BY event_type
      ORDER BY count(*) DESC
      LIMIT 8`,
    [workspaceId, id, days],
  );
  const last = await pool.query<{ last_active: string | null }>(
    `SELECT to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_active
       FROM domain_events WHERE workspace_id = $1 AND actor_id = $2`,
    [workspaceId, id],
  );
  const toolRows = tools.rows.map((r) => ({ tool: r.tool, ok: Number(r.ok), failed: Number(r.failed), total_ms: Number(r.total_ms) }));
  return {
    days,
    last_active: last.rows[0]?.last_active ?? null,
    tool_calls: toolRows.reduce((a, r) => a + r.ok + r.failed, 0),
    tool_failures: toolRows.reduce((a, r) => a + r.failed, 0),
    tool_time_ms: toolRows.reduce((a, r) => a + r.total_ms, 0),
    by_tool: toolRows,
    changes: changes.rows.reduce((a, r) => a + Number(r.count), 0),
    by_event_type: changes.rows.map((r) => ({ event_type: r.event_type, count: Number(r.count) })),
  };
}

// Soft-revoke a token. Sets revoked_at; the row stays so audit chains
// referencing this token remain resolvable. Idempotent. Admin-only.
export async function revokeTokenOf(authenticated: ActorCtx | null, id: string, tokenId: string): Promise<{ ok: true; revoked: boolean }> {
  const actor = await principal(authenticated);
  const workspaceId = await getWorkspaceId();
  await requireMember(workspaceId, id);
  // Idempotency without a spurious audit event: skip the mutation (and its
  // TOKEN_REVOKED event) when the token is already revoked or absent.
  const live = await pool.query(
    `SELECT 1 FROM agent_tokens WHERE id = $1 AND actor_id = $2 AND revoked_at IS NULL`,
    [tokenId, id],
  );
  if (!live.rows[0]) return { ok: true, revoked: false };
  const changed = await mutate({
    actor,
    workspaceId,
    // Revoking a token removes everything that bearer could read → bump.
    affectsMembership: true,
    authority: { kind: "principal_admin" },
    event: { type: "TOKEN_REVOKED", targetType: "token", targetId: tokenId, payload: { actor_id: id } },
    apply: async () => revokeToken(id, tokenId),
  });
  return { ok: true, revoked: changed };
}

// Hard-delete a token. Removes the row entirely. Prefer POST /revoke for
// most cases — DELETE breaks the link from past audit events to the token
// that produced them. Kept for admin housekeeping. Admin-only.
export async function deleteToken(authenticated: ActorCtx | null, id: string, tokenId: string): Promise<{ ok: true }> {
  const actor = await principal(authenticated);
  const workspaceId = await getWorkspaceId();
  await requireMember(workspaceId, id);
  // Confirm the token actually exists before emitting TOKEN_DELETED — deleting a
  // phantom token must not write a spurious audit event.
  const tokenExists = await pool.query(`SELECT 1 FROM agent_tokens WHERE id = $1 AND actor_id = $2`, [tokenId, id]);
  if (!tokenExists.rows[0]) return { ok: true }; // nothing to delete, no event
  await mutate({
    actor,
    workspaceId,
    // Hard-deleting a token removes everything that bearer could read → bump
    // (same membership effect as revoke).
    affectsMembership: true,
    authority: { kind: "principal_admin" },
    event: { type: "TOKEN_DELETED", targetType: "token", targetId: tokenId, payload: { actor_id: id } },
    apply: async () => {
      await q(`DELETE FROM agent_tokens WHERE id = $1 AND actor_id = $2`, [tokenId, id]);
    },
  });
  return { ok: true };
}

/** Remove a member (never the owner: 409 owner_cannot_be_removed): tokens they issued are revoked, the tokens they hold and
 *  their space seats go with the row (FK cascade), their personal space is
 *  left ownerless and closed, their personal module rows go, and a human's
 *  login is blocked from re-creating them. An absent id is a no-op; nobody
 *  removes themselves. The built-in System actor is removable only where the
 *  native bypass is off (production): while it is on, the bypass signs in as
 *  System, so the refusal is an honest 409 instead of a silent no-op. */
export async function removeActor(authenticated: ActorCtx | null, id: string): Promise<{ ok: true }> {
  const actor = await principal(authenticated);
  if (actor.id === id) throw new ActorAdminError(403, { error: "cannot delete self" });
  const workspaceId = await getWorkspaceId();
  // Confirm the actor exists before emitting an ACTOR_DELETED event.
  const target = await pool.query<{ name: string; is_system: boolean; type: string }>(
    `SELECT name, type, (external_id = ${SYSTEM_EXTERNAL_ID_SQL}) IS TRUE AS is_system FROM actors WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  if (!target.rows[0]) return { ok: true }; // absent → no-op, no event
  // A temporary session is ended, never removed: its `actors` row is what this node keeps as the evidence that the id was a session's, for as long as
  // anything names the id (the stamps of its membership, which must never leave: spine/snapshotTables.json `neverLeaves`; the authors of its writes,
  // shown as a session: services/authorName.ts). Ending it is services/participantSessions.ts endTemporarySession.
  if (isSessionActorType(target.rows[0].type)) {
    throw new ActorAdminError(409, { error: "session_not_removable", detail: "a temporary session is ended, not removed" });
  }
  // The owner is handed over, never removed (services/ownerTransfer.ts): removing
  // them would leave the workspace with no owner.
  const isOwner = await pool.query(`SELECT 1 FROM workspaces WHERE id = $1 AND owner_actor_id = $2`, [workspaceId, id]);
  if (isOwner.rows[0]) {
    throw new ActorAdminError(409, { error: "owner_cannot_be_removed", detail: "hand the workspace to someone else first (transfer ownership)" });
  }
  if (target.rows[0].is_system && nativeBypassEnabled()) {
    throw new ActorAdminError(409, {
      error: "system_actor_in_use",
      detail: "the sign-in-free development admin is on here and signs in as System; it can be removed where that is off (production)",
    });
  }
  const removed = await mutate({
    actor,
    workspaceId,
    // The tokens they issued stop reading anything (below) → bump.
    affectsMembership: true,
    authority: { kind: "principal_admin" },
    event: { type: "ACTOR_DELETED", targetType: "actor", targetId: id, payload: { name: target.rows[0].name } },
    apply: async () => {
      // A token never outlives the person who issued it: whichever agent holds
      // it, it is revoked with them (the delete would otherwise null issued_by).
      await revokeTokensIssuedBy(workspaceId, id);
      // The same for the temporary sessions they opened: they end with the person.
      await endTemporarySessionsOpenedBy(workspaceId, id);
      // Their personal space becomes a shared space nobody is in, every
      // switch off — through the space service, so its SPACE_UPDATED is
      // recorded and the published site drops their pages (D118).
      await orphanPersonalSpace(actor, workspaceId, id, target.rows[0]!.name);
      const row = await q<{ type: string; external_id: string | null }>(
        // `type <> 'session'`: the one statement that deletes an actor never takes a session's row (above; the invariant
        // guards/neverLeaves.guard.test.ts names and sessionActorKept.integration.test.ts tests).
        `DELETE FROM actors WHERE workspace_id = $1 AND id = $2 AND type <> 'session'
         RETURNING type, external_id`,
        [workspaceId, id],
      );
      // Personal progress keyed by actor id (migration 092) goes with them:
      // their module settings and each module's declared personal tables.
      if (row.rows[0]) {
        for (const table of ["actor_module_settings", ...registeredPersonalTables()]) {
          await q(`DELETE FROM ${sqlIdentifier(table)} WHERE actor_id = $1`, [id]);
        }
      }
      // A human's login would otherwise re-create this actor on its next
      // request (GAP-237); the record commits with the delete.
      const externalId = row.rows[0]?.type === "human" ? row.rows[0].external_id : null;
      if (externalId) await recordMemberRemoval(workspaceId, externalId);
      return externalId;
    },
  });
  if (removed) await endUserSessions(removed);
  return { ok: true };
}
