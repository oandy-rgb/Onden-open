// Member invites (audit D110). Adding a person in Settings › Users & Agents is
// an invite: the actor row waits with external_id NULL until a sign-in
// presents the owner's ONE-TIME INVITE LINK and has the invited email — both
// — and claims it (services/actors.ts actorForSession). An email alone claims
// nothing: anyone who knows an address could otherwise take the invite.
//
// The link carries a random token; the row keeps only its sha256 (as
// agent_tokens.token_hash does), an expiry and when it was spent. The owner
// sees the full link once, when it is made or remade.
//
// Kept apart from services/actors.ts because auth.ts reads it (the signup gate
// lets a valid invite link through) and services/actors.ts already depends on
// auth.ts through memberRemovals — this module needs only the database.
import { randomBytes } from "node:crypto";
import { q } from "../db.js";
import { sha256Hex } from "../utils.js";

/** How long an invite link stays valid. */
export const INVITE_TTL_DAYS = 14;
/** "ondi" = onden invite; the prefix tells it apart from an agent token. */
const INVITE_PREFIX = "ondi_";

/** The one form an invite email is stored and compared in: trimmed, lower
 *  case. null when it is missing or does not look like an address. */
export function normalizeInviteEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

export function hashInviteToken(token: string): string {
  return sha256Hex(token);
}

/** A fresh link token, its hash and its expiry. The plaintext leaves the
 *  server once, in the owner's response; only the hash is stored. */
export function mintInviteToken(): { token: string; hash: string; expiresAt: Date } {
  const token = INVITE_PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashInviteToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000) };
}

/** Why an invite link does not admit this login. */
export type InviteRefusal = "invite_invalid" | "invite_used" | "invite_expired" | "invite_email_mismatch";

export class InviteError extends Error {
  constructor(readonly code: InviteRefusal | "already_member", readonly status: 403 | 404 | 409 | 410) {
    super(code);
    this.name = "InviteError";
  }
}

const REFUSAL_STATUS: Record<InviteRefusal, 403 | 404 | 410> = {
  invite_invalid: 404,
  invite_used: 410,
  invite_expired: 410,
  invite_email_mismatch: 403,
};

type InviteRow = {
  id: string; workspace_id: string; invite_email: string | null; external_id: string | null;
  invite_expires_at: Date | null; invite_used_at: Date | null;
};

/** The invite a link token names, or why it admits nobody / not this email.
 *  `workspaceId` narrows it to one workspace (the claim); the signup gate
 *  asks across all (accounts are server-wide). Reads through q(), so inside
 *  a transaction it sees that transaction (and `forUpdate` locks the row). */
export async function checkInviteToken(
  rawToken: unknown, rawEmail: unknown, opts: { workspaceId?: string; forUpdate?: boolean } = {},
): Promise<{ ok: true; invite: InviteRow } | { ok: false; refusal: InviteRefusal; invite?: InviteRow }> {
  if (typeof rawToken !== "string" || !rawToken.startsWith(INVITE_PREFIX)) return { ok: false, refusal: "invite_invalid" };
  const r = await q<InviteRow>(
    `SELECT id::text, workspace_id::text, invite_email, external_id, invite_expires_at, invite_used_at
       FROM actors
      WHERE invite_token_hash = $1 AND type = 'human' AND ($2::uuid IS NULL OR workspace_id = $2::uuid)
      ${opts.forUpdate ? "FOR UPDATE" : ""}`,
    [hashInviteToken(rawToken), opts.workspaceId ?? null],
  );
  const invite = r.rows[0];
  if (!invite) return { ok: false, refusal: "invite_invalid" };
  if (invite.invite_used_at || invite.external_id) return { ok: false, refusal: "invite_used", invite };
  if (!invite.invite_expires_at || invite.invite_expires_at.getTime() <= Date.now()) return { ok: false, refusal: "invite_expired", invite };
  const email = normalizeInviteEmail(rawEmail);
  if (!email || email !== invite.invite_email) return { ok: false, refusal: "invite_email_mismatch", invite };
  return { ok: true, invite };
}

export function inviteRefusal(refusal: InviteRefusal): InviteError {
  return new InviteError(refusal, REFUSAL_STATUS[refusal]);
}

/** The signup gate's question: does this sign-up carry a valid invite link
 *  whose email is the one signing up? (Any workspace.) null = no link. */
export async function signupInviteAnswer(rawToken: unknown, rawEmail: unknown): Promise<"admitted" | InviteRefusal | null> {
  if (!rawToken) return null;
  const check = await checkInviteToken(rawToken, rawEmail);
  return check.ok ? "admitted" : check.refusal;
}

/** The invite token a request carries: the X-Onden-Invite header (email
 *  sign-up from the app), else the onden_invite cookie (a first OAuth sign-in,
 *  whose callback request carries no app header). */
export function inviteTokenFrom(headers: Headers | undefined | null): string | null {
  if (!headers) return null;
  const header = headers.get("x-onden-invite")?.trim();
  if (header) return header;
  const cookie = headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)onden_invite=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]!) : null;
}
