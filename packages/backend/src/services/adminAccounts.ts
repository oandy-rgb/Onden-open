// Account recovery for self-hosters, driven by the container command
// `node dist/admin.js` (src/admin.ts) — never by an HTTP route.
//
// Contract:
//   • The auth tables (user / account / session) belong to better-auth, whose
//     own adapter runs on a separate connection and so cannot share our
//     transaction. These writes use q() instead, so the change and its audit
//     event commit or roll back together (AGENTS.md: state change + event in
//     one transaction). The password is hashed with better-auth's own hasher
//     (auth.$context.password), so a login verifies it exactly as for a
//     password set through sign-up.
//   • There is no signed-in actor here, so spine mutate() (which derives a
//     user/ai_agent actor) does not apply; like other non-actor automation the
//     event is written with event() as actor_type 'system'. ADMIN_CLI_ACTOR_ID
//     names the operator for the audit trail: whoever can run the command
//     already controls the container and the database.
//   • Event payloads carry counts only — never the password, its hash, the
//     email, or a session token.
import { auth } from "../auth.js";
import { event, getWorkspaceId, q, withTransaction } from "../db.js";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../authPasswordRules.js";
import { SYSTEM_EXTERNAL_ID_SQL } from "../spine/systemActor.js";

export const ADMIN_CLI_ACTOR_ID = "admin-cli";
export const ADMIN_PASSWORD_RESET = "ADMIN_PASSWORD_RESET";
export const ADMIN_SESSIONS_REVOKED = "ADMIN_SESSIONS_REVOKED";

/** A refusal the operator can act on; the message is shown as is. */
export class AdminCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminCommandError";
  }
}

export interface AccountSummary {
  email: string;
  /** Onden has two roles (migration 127): the owner and members. */
  isOwner: boolean;
  /** Start of the newest session still on record; null when there is none
   *  (never signed in, or sessions were revoked/expired and cleaned up). */
  lastSignInAt: Date | null;
}

/** Accounts for the `users` command. Selects named columns only, so no
 *  password hash or session token can reach the output. */
export async function listAccounts(): Promise<AccountSummary[]> {
  const workspaceId = await getWorkspaceId();
  const r = await q<{ email: string; is_owner: boolean | null; last_sign_in_at: Date | null }>(
    `SELECT u.email,
            (w.owner_actor_id = a.id OR a.external_id = ${SYSTEM_EXTERNAL_ID_SQL}) AS is_owner,
            (SELECT max(s."createdAt") FROM "session" s WHERE s."userId" = u.id) AS last_sign_in_at
       FROM "user" u
       LEFT JOIN actors a ON a.external_id = u.id AND a.workspace_id = $1
       LEFT JOIN workspaces w ON w.id = $1
      ORDER BY u."createdAt", u.email`,
    [workspaceId],
  );
  return r.rows.map((row) => ({
    email: row.email,
    isOwner: row.is_owner === true,
    lastSignInAt: row.last_sign_in_at,
  }));
}

export function assertPasswordAllowed(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new AdminCommandError(`密碼長度須在 ${PASSWORD_MIN_LENGTH} 到 ${PASSWORD_MAX_LENGTH} 個字元之間。`);
  }
}

async function findUserId(email: string): Promise<string> {
  const r = await q<{ id: string }>(`SELECT id FROM "user" WHERE lower(email) = lower($1)`, [email.trim()]);
  if (!r.rows[0]) throw new AdminCommandError("找不到這個 email 的帳號。可先用 users 指令看有哪些帳號。");
  return r.rows[0].id;
}

/** Set a new password for the account and end all its sessions. Returns how
 *  many sessions were ended. */
export async function resetPassword(email: string, newPassword: string): Promise<{ sessionsEnded: number }> {
  assertPasswordAllowed(newPassword);
  const hash = await (await auth.$context).password.hash(newPassword);
  const workspaceId = await getWorkspaceId();
  return withTransaction(async () => {
    const userId = await findUserId(email);
    const updated = await q(
      `UPDATE "account" SET password = $1, "updatedAt" = now()
        WHERE "userId" = $2 AND "providerId" = 'credential'`,
      [hash, userId],
    );
    if (!updated.rowCount) {
      throw new AdminCommandError("這個帳號沒有密碼登入（可能是用 GitHub 或 Google 登入），無法重設密碼。");
    }
    const ended = await q(`DELETE FROM "session" WHERE "userId" = $1`, [userId]);
    await event(
      workspaceId, ADMIN_PASSWORD_RESET, "user", userId,
      { sessions_ended: ended.rowCount ?? 0 },
      "system", ADMIN_CLI_ACTOR_ID,
    );
    return { sessionsEnded: ended.rowCount ?? 0 };
  });
}

/** End every session of the account. Returns how many were ended. */
export async function revokeSessions(email: string): Promise<{ sessionsEnded: number }> {
  const workspaceId = await getWorkspaceId();
  return withTransaction(async () => {
    const userId = await findUserId(email);
    const ended = await q(`DELETE FROM "session" WHERE "userId" = $1`, [userId]);
    await event(
      workspaceId, ADMIN_SESSIONS_REVOKED, "user", userId,
      { sessions_ended: ended.rowCount ?? 0 },
      "system", ADMIN_CLI_ACTOR_ID,
    );
    return { sessionsEnded: ended.rowCount ?? 0 };
  });
}
