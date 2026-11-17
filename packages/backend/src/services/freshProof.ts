// "This person has just proved who they are": the ONE service a route asks when what it hands out, or destroys, must not be done by a request that
// merely holds a session (a stolen cookie, a page left open on a shared machine).
//
//   // 1. the page presents evidence once and gets a ticket          POST /api/fresh-proof   (routes/freshProof.ts)
//   const { ticket, expiresInSeconds } = await issueFreshProof(actor, "snapshot_export", { kind: "password", password });
//   // 2. the guarded route takes the ticket from the request and spends it, before it does anything
//   await consumeFreshProof(actor, "snapshot_export", c.req.header(FRESH_PROOF_HEADER));
//
// ANOTHER ROUTE USES THIS UNCHANGED: add its purpose to FRESH_PROOF_PURPOSES (one line, so a ticket made for one thing never opens another) and
// call consumeFreshProof first. Which routes should is the owner's decision (docs/architecture/proposals/add-device-snapshot-2026-11-15.md lists them).
//
// WHAT A TICKET IS: 32 random bytes the page holds; the database keeps only their SHA-256 (fresh_proofs, migration 207), the person it was given to, the
// sign-in SESSION it was given in (requestContext.ts currentSessionId, set by the actor middleware in app.ts; a ticket made in one session is "invalid" in
// another, so a confirmation on device A cannot be spent from device B), its purpose and its end (FRESH_PROOF_TTL_SECONDS from now, by the database's clock). It is good once: the spend is ONE conditional UPDATE, so two
// requests with the same ticket cannot both win, on any number of server processes. A ticket is a secret: it is never logged, never put in a URL
// (a header carries it) and never in an event.
//
// WHAT THE SERVER CAN CHECK (the evidence), and nothing more:
//   password         the sign-in's own password check (better-auth's hasher against the account's stored hash), for a person who has a password.
//                    Attempts are COUNTED IN THE DATABASE (fresh_proof_attempts) and the count is taken BEFORE the check, so a burst of parallel guesses
//                    cannot get past it: five wrong passwords in a row lock the person for 15 minutes, each wrong attempt after a lock ends doubles it (a
//                    day at most), a right password clears the count, and the attempt that locks leaves a FRESH_PROOF_LOCKED event the owner sees. A right
//                    password never uses up the allowance of the wrong ones (the two are not one counter). A lock cannot tell the owner from someone holding
//                    their session: the same lock that stops guessing lets that someone keep the owner out for as long as they keep guessing, and the event
//                    is how the owner finds out. better-auth's own limiter belongs to its HTTP handler and does not see a call made from here.
//   acknowledgement  ONLY where BOTH hold: this backend is the browser version (config ONDEN_BROWSER_APP, set by browser/env.ts and by nothing on a server) AND
//                    the account's password is the public one of that version's one local person (browser/localSession.ts: the same on every device, no
//                    secret). There the server has nothing to check beyond "a request came, now": the ticket proves a deliberate second request within two
//                    minutes, not who made it. That is stated, not hidden. On a server an acknowledgement is never enough, whatever the password is, so an
//                    account moved over from the browser version without changing its password still has to type it (`fresh_proof_password_needed`).
// A person who signs in only with Google or GitHub has no password: `fresh_proof_no_password`. BEFORE this ticket guards the full backup or the whole export,
// those people need an equivalent proof (sign in again through the provider, asking it to re-authenticate, then issue the ticket) or they are locked out of
// their own backup: that is open (docs/architecture/proposals/add-device-snapshot-2026-11-15.md) and must not become a second path next to this one.

import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { auth } from "../auth.js";
import { LOCAL_ACCOUNT } from "../browser/localSession.js";
import { config } from "../config.js";
import { db } from "../dbKysely.js";
import { currentSessionId } from "../requestContext.js";
import { requirePerson } from "../spine/authority.js";
import { mutate, mutatePersonal } from "../spine/mutate.js";
import { CodedStatusError } from "../statusError.js";
import type { ActorCtx } from "../types.js";
import { sha256Hex } from "../utils.js";
import { getWorkspaceId } from "./workspaceId.js";

/** What a ticket is for. A new guarded route adds its own name here. */
export const FRESH_PROOF_PURPOSES = ["snapshot_export", "open_session"] as const;
type FreshProofPurpose = (typeof FRESH_PROOF_PURPOSES)[number];

/** The request header that carries a ticket to the guarded route (never a URL: URLs are logged). A custom header also makes a cross-site GET go through a
 *  preflight first, which the server's origin rules refuse: that is a property this relies on, so a ticket must not be moved to the query string (say, for
 *  an `<a download>`) without another answer to cross-site requests. */
export const FRESH_PROOF_HEADER = "x-onden-fresh-proof";

const FRESH_PROOF_TTL_SECONDS = 120;
/** Wrong passwords in a row that are free; the one after them locks for LOCK_BASE_SECONDS, then each wrong attempt after a lock ends doubles it, up to LOCK_MAX_SECONDS. */
const FREE_WRONG_PASSWORDS = 5;
const LOCK_BASE_SECONDS = 15 * 60;
const LOCK_MAX_SECONDS = 24 * 60 * 60;
/** A used or expired row stays this long, so a second try is answered `fresh_proof_used` / `fresh_proof_expired` and not as an unknown ticket. The clean-up
 *  runs when the next ticket is handed out (nothing is cleaned while nobody asks; the rows are few and small). */
const KEEP_SECONDS = 600;

type FreshEvidence = { kind: "password"; password: string } | { kind: "acknowledgement" };

class FreshProofRefused extends CodedStatusError {}
// 403, never 401: a 401 is how the app learns the sign-in is gone, and a wrong password is not that.
const refuse = (code: string, message: string) => new FreshProofRefused(403, code, message);

/** The credential the sign-in checks this person's password against, or null when they have none (a Google or GitHub sign-in only). Read through the
 *  sign-in library's own adapter, so the account table's layout is the library's business. */
async function credentialHashOf(actor: ActorCtx): Promise<string | null> {
  const login = (await db.selectFrom("actors").select("external_id").where("id", "=", actor.id).executeTakeFirst())?.external_id;
  if (!login) return null;
  const accounts = await (await auth.$context).internalAdapter.findAccounts(login);
  return accounts.find((account) => account.providerId === "credential")?.password ?? null;
}

type Claim = { lockedForSeconds: number | null; failures: number; newlyLockedForSeconds: number | null };

/** Count this password attempt BEFORE it is checked, under the write entry's lock (so parallel attempts are counted one after the other), and say whether
 *  the person is locked. The attempt that reaches the free limit sets the lock at once, so only that one attempt gets through it. */
async function claimPasswordAttempt(actor: ActorCtx): Promise<Claim> {
  return mutatePersonal({ actor, workspaceId: await getWorkspaceId(), apply: async () => {
    await sql`INSERT INTO fresh_proof_attempts (actor_id) VALUES (${actor.id}) ON CONFLICT (actor_id) DO NOTHING`.execute(db);
    const row = (await sql<{ failures: number; wait: number | null }>`
      SELECT failures, CASE WHEN locked_until > now() THEN ceil(extract(epoch FROM locked_until - now()))::int END AS wait
        FROM fresh_proof_attempts WHERE actor_id = ${actor.id} FOR UPDATE`.execute(db)).rows[0]!;
    if (row.wait !== null) return { lockedForSeconds: row.wait, failures: row.failures, newlyLockedForSeconds: null };
    const failures = row.failures + 1;
    const lock = failures >= FREE_WRONG_PASSWORDS ? Math.min(LOCK_BASE_SECONDS * 2 ** (failures - FREE_WRONG_PASSWORDS), LOCK_MAX_SECONDS) : null;
    await sql`UPDATE fresh_proof_attempts SET failures = ${failures}, locked_until = ${lock === null ? sql`NULL` : sql`now() + make_interval(secs => ${lock})`}
               WHERE actor_id = ${actor.id}`.execute(db);
    return { lockedForSeconds: null, failures, newlyLockedForSeconds: lock };
  } });
}

/** A right password: the count starts again. */
async function clearPasswordAttempts(actor: ActorCtx): Promise<void> {
  await mutatePersonal({ actor, workspaceId: await getWorkspaceId(), apply: async () => { await sql`DELETE FROM fresh_proof_attempts WHERE actor_id = ${actor.id}`.execute(db); } });
}

/** The wrong attempt that locked the person is a fact the owner should be able to see (events about an actor are the owner's and that person's to read). It
 *  holds how many wrong attempts and for how long, never a password. If writing it fails the lock stands and the request fails: the safe direction. */
async function recordLock(actor: ActorCtx, claim: Claim): Promise<void> {
  await mutate({
    actor, workspaceId: await getWorkspaceId(),
    authority: { kind: "open", why: "records a lock on the actor's own confirmation attempts; the lock itself was set by their own wrong passwords" },
    event: { type: "FRESH_PROOF_LOCKED", targetType: "actor", targetId: actor.id, payload: { failures: claim.failures, locked_for_seconds: claim.newlyLockedForSeconds } },
    apply: async () => undefined,
  });
}

async function checkEvidence(actor: ActorCtx, evidence: FreshEvidence): Promise<void> {
  const hash = await credentialHashOf(actor);
  if (hash === null) throw refuse("fresh_proof_no_password", "this account has no password, so it cannot be asked for one");
  const { password } = (await auth.$context);
  if (evidence.kind === "acknowledgement") {
    // Only in the browser version, and only for its one local person, whose password is public by design: then an acknowledgement is all there is to ask for.
    // On a server it never is, even for an account whose password happens to be that public string (moved over from the browser version, say).
    if (!config.is("ONDEN_BROWSER_APP", "1") || !(await password.verify({ hash, password: LOCAL_ACCOUNT.password }))) throw refuse("fresh_proof_password_needed", "this account has a password of its own: type it");
    return;
  }
  const claim = await claimPasswordAttempt(actor);
  if (claim.lockedForSeconds !== null) throw refuse("fresh_proof_locked", `too many wrong passwords: wait ${claim.lockedForSeconds} seconds`);
  if (!(await password.verify({ hash, password: evidence.password }))) {
    if (claim.newlyLockedForSeconds !== null) await recordLock(actor, claim);
    throw refuse("fresh_proof_wrong_password", "the password is not right");
  }
  await clearPasswordAttempts(actor);
}

/** Hand `actor` a ticket for `purpose`, after the evidence checks out. A token is not a person and gets none. */
export async function issueFreshProof(actor: ActorCtx, purpose: FreshProofPurpose, evidence: FreshEvidence): Promise<{ ticket: string; expiresInSeconds: number }> {
  requirePerson(actor, "fresh_proof");
  await checkEvidence(actor, evidence);
  return grantFreshProof(actor, purpose);
}

/** Make and store the ticket: only issueFreshProof calls it, after the evidence is checked (guards/freshProof.guard.test.ts keeps every other file out of the table). */
async function grantFreshProof(actor: ActorCtx, purpose: FreshProofPurpose): Promise<{ ticket: string; expiresInSeconds: number }> {
  const ticket = randomBytes(32).toString("base64url");
  await sql`DELETE FROM fresh_proofs WHERE expires_at < now() - make_interval(secs => ${KEEP_SECONDS})`.execute(db);
  await db.insertInto("fresh_proofs")
    .values({ ticket_hash: sha256Hex(ticket), actor_id: actor.id, purpose, session_id: currentSessionId() ?? null, expires_at: sql<Date>`now() + make_interval(secs => ${FRESH_PROOF_TTL_SECONDS})` })
    .execute();
  return { ticket, expiresInSeconds: FRESH_PROOF_TTL_SECONDS };
}

/** Spend the ticket the request carried: once, within its time, by the person it was given to, for this purpose. Anything else is refused with a code
 *  that says which (missing, unknown, expired, used), and nothing is spent by a refusal. Call it BEFORE the route does or reads anything. */
export async function consumeFreshProof(actor: ActorCtx, purpose: FreshProofPurpose, ticket: string | null | undefined): Promise<void> {
  if (!ticket) throw refuse("fresh_proof_required", "this needs a fresh confirmation first");
  const hash = sha256Hex(ticket);
  const session = currentSessionId() ?? null;
  const spent = await sql`UPDATE fresh_proofs SET used_at = now()
                           WHERE ticket_hash = ${hash} AND actor_id = ${actor.id} AND purpose = ${purpose} AND session_id IS NOT DISTINCT FROM ${session} AND used_at IS NULL AND expires_at > now()
                       RETURNING 1`.execute(db);
  if (spent.rows.length > 0) return;
  // Not spent: tell why. Only the person it was given to, in this session, for this purpose, may learn that it was used or expired; for anyone else it is unknown.
  const row = (await sql<{ used: boolean; live: boolean }>`SELECT used_at IS NOT NULL AS used, expires_at > now() AS live FROM fresh_proofs
                                                              WHERE ticket_hash = ${hash} AND actor_id = ${actor.id} AND purpose = ${purpose} AND session_id IS NOT DISTINCT FROM ${session}`.execute(db)).rows[0];
  if (!row) throw refuse("fresh_proof_invalid", "this confirmation is not one this server gave");
  throw row.used ? refuse("fresh_proof_used", "this confirmation was already used") : refuse("fresh_proof_expired", "this confirmation ran out");
}
