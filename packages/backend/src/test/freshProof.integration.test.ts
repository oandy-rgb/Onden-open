// "Enter the password again" enforced by the server (services/freshProof.ts, POST /api/fresh-proof): a ticket is made only after the evidence checks out, is good
// once and for two minutes, belongs to one person and one purpose, is never stored or logged in the clear, and wrong passwords are counted in the database and lock the person for longer each time.
// Real better-auth accounts (a password hash made by the sign-in's own hasher) in the isolated test database; the snapshot route's use of a ticket is in
// stampedSnapshotTwoProcess.integration.test.ts (the ticket gate of GET /api/snapshot).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getWorkspaceId, q } from "../db.js";
import { apiOnError } from "../httpError.js";
import { log } from "../logger.js";
import { LOCAL_ACCOUNT } from "../browser/localSession.js";
import { consumeFreshProof, FRESH_PROOF_HEADER, issueFreshProof } from "../services/freshProof.js";
import freshProofRouter from "../routes/freshProof.js";
import { withRequestSession } from "../requestContext.js";
import snapshotRouter from "../routes/stampedSnapshot.js";
import { sha256Hex } from "../utils.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";

process.env.ONDEN_SIGNUP = "open"; // the sign-up rule is not what is tested here (auth.ts reads it once, at import)
const { auth } = await import("../auth.js");

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("a fresh proof: a ticket for a person who has just shown who they are", () => {
  let ws: string;

  beforeAll(async () => {
    await (await auth.$context).runMigrations();
    ws = await getWorkspaceId();
  }, 60_000);
  afterEach(() => { vi.restoreAllMocks(); });

  /** A person of the workspace with a sign-in of their own: a better-auth user whose id is the actor's login. */
  async function person(options: { email?: string; password?: string; providerId?: "credential" | "github" } = {}): Promise<{ actor: ActorCtx; password: string }> {
    const password = options.password ?? `Pw-${randomUUID()}`;
    const email = options.email ?? `${randomUUID()}@fresh-proof.test`;
    let userId: string;
    if (options.providerId === "github") {
      userId = randomUUID();
      await q(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, 'Social', $2, true, now(), now())`, [userId, email]);
      await q(`INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES ($1, $2, 'github', $3, now(), now())`, [randomUUID(), randomUUID(), userId]);
    } else {
      userId = (await auth.api.signUpEmail({ body: { name: "Fresh", email, password } })).user.id;
    }
    const actor = await persistActor(ws, { id: "", name: "Fresh", role: "editor", type: "human" });
    await q(`UPDATE actors SET external_id = $1 WHERE id = $2`, [userId, actor.id]);
    return { actor, password };
  }
  const rows = async (actorId: string) => (await q<{ ticket_hash: string; purpose: string; used_at: string | null }>(`SELECT ticket_hash, purpose, used_at FROM fresh_proofs WHERE actor_id = $1`, [actorId])).rows;
  const codeOf = async (promise: Promise<unknown>) => promise.then(() => "resolved", (error: { code?: string; name?: string }) => error.code ?? error.name);

  it("a right password gets a ticket that is spent once: a second use says it was used", async () => {
    const { actor, password } = await person();
    const { ticket, expiresInSeconds } = await issueFreshProof(actor, "snapshot_export", { kind: "password", password });
    expect(expiresInSeconds).toBe(120); // two minutes
    await consumeFreshProof(actor, "snapshot_export", ticket);
    expect(await codeOf(consumeFreshProof(actor, "snapshot_export", ticket))).toBe("fresh_proof_used");
  });

  it("a wrong password gets nothing, and leaves nothing behind", async () => {
    const { actor } = await person();
    expect(await codeOf(issueFreshProof(actor, "snapshot_export", { kind: "password", password: "not the password" }))).toBe("fresh_proof_wrong_password");
    expect(await rows(actor.id)).toEqual([]);
  });

  it("the database keeps only the hash of a ticket", async () => {
    const { actor, password } = await person();
    const { ticket } = await issueFreshProof(actor, "snapshot_export", { kind: "password", password });
    const stored = await rows(actor.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.ticket_hash).toBe(sha256Hex(ticket));
    expect(JSON.stringify(stored)).not.toContain(ticket);
  });

  it("a missing, an unknown, someone else's and another purpose's ticket are refused, and each refusal spends nothing", async () => {
    const first = await person();
    const mine = first.actor;
    const other = (await person()).actor;
    const { ticket } = await issueFreshProof(mine, "snapshot_export", { kind: "password", password: first.password });
    expect(await codeOf(consumeFreshProof(mine, "snapshot_export", undefined))).toBe("fresh_proof_required");
    expect(await codeOf(consumeFreshProof(mine, "snapshot_export", ""))).toBe("fresh_proof_required");
    expect(await codeOf(consumeFreshProof(mine, "snapshot_export", "not-a-ticket"))).toBe("fresh_proof_invalid");
    expect(await codeOf(consumeFreshProof(other, "snapshot_export", ticket))).toBe("fresh_proof_invalid");
    expect(await codeOf(consumeFreshProof(mine, "another_purpose" as never, ticket))).toBe("fresh_proof_invalid");
    expect((await rows(mine.id))[0]!.used_at).toBeNull(); // still good for its owner and purpose
    await consumeFreshProof(mine, "snapshot_export", ticket);
  });

  it("an expired ticket says it ran out and is not spent; a used one stays 'used' after it would have expired", async () => {
    const { actor, password } = await person();
    const get = () => issueFreshProof(actor, "snapshot_export", { kind: "password", password });
    const old = await get();
    await q(`UPDATE fresh_proofs SET expires_at = now() - interval '1 second' WHERE ticket_hash = $1`, [sha256Hex(old.ticket)]);
    expect(await codeOf(consumeFreshProof(actor, "snapshot_export", old.ticket))).toBe("fresh_proof_expired");
    expect((await rows(actor.id)).find((r) => r.ticket_hash === sha256Hex(old.ticket))!.used_at).toBeNull();

    const spent = await get();
    await consumeFreshProof(actor, "snapshot_export", spent.ticket);
    await q(`UPDATE fresh_proofs SET expires_at = now() - interval '1 second' WHERE ticket_hash = $1`, [sha256Hex(spent.ticket)]);
    expect(await codeOf(consumeFreshProof(actor, "snapshot_export", spent.ticket))).toBe("fresh_proof_used");
  });

  it("rows long past their end are cleaned out when the next ticket is handed out", async () => {
    const { actor, password } = await person();
    const get = () => issueFreshProof(actor, "snapshot_export", { kind: "password", password });
    const old = await get();
    await q(`UPDATE fresh_proofs SET expires_at = now() - interval '1 hour' WHERE ticket_hash = $1`, [sha256Hex(old.ticket)]);
    await get();
    expect((await rows(actor.id)).map((r) => r.ticket_hash)).not.toContain(sha256Hex(old.ticket));
  });

  it("two requests with one ticket: exactly one wins (one conditional update, not read-then-write)", async () => {
    const { actor, password } = await person();
    const { ticket } = await issueFreshProof(actor, "snapshot_export", { kind: "password", password });
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => consumeFreshProof(actor, "snapshot_export", ticket)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as { code: string }).code).toBe("fresh_proof_used");
  });

  it("a ticket is bound to the sign-in session it was handed in: in another session it is invalid and spends nothing, in its own it works once", async () => {
    const { actor, password } = await person();
    const { ticket } = await withRequestSession("session-A", () => issueFreshProof(actor, "snapshot_export", { kind: "password", password }));
    expect((await rows(actor.id))[0]!.used_at).toBeNull();
    expect(await codeOf(withRequestSession("session-B", () => consumeFreshProof(actor, "snapshot_export", ticket)))).toBe("fresh_proof_invalid");
    expect(await codeOf(consumeFreshProof(actor, "snapshot_export", ticket))).toBe("fresh_proof_invalid"); // a request with no session either
    expect((await rows(actor.id))[0]!.used_at).toBeNull();
    await withRequestSession("session-A", () => consumeFreshProof(actor, "snapshot_export", ticket));
    expect(await codeOf(withRequestSession("session-A", () => consumeFreshProof(actor, "snapshot_export", ticket)))).toBe("fresh_proof_used");
  });

  it("a token is not a person: it gets no ticket", async () => {
    const { actor, password } = await person();
    const asToken = { ...actor, tokenScope: { access: "write", allowedTools: [], tokenId: "t" } as never };
    expect(await codeOf(issueFreshProof(asToken, "snapshot_export", { kind: "password", password }))).not.toBe("resolved");
    expect(await rows(actor.id)).toEqual([]);
  });

  it("an account with no password (Google or GitHub only) is told so, whatever it presents", async () => {
    const { actor } = await person({ providerId: "github" });
    expect(await codeOf(issueFreshProof(actor, "snapshot_export", { kind: "password", password: "anything" }))).toBe("fresh_proof_no_password");
    expect(await codeOf(issueFreshProof(actor, "snapshot_export", { kind: "acknowledgement" }))).toBe("fresh_proof_no_password");
    expect(await rows(actor.id)).toEqual([]);
  });

  it("an acknowledgement is enough only in the browser version AND for its one local person; on a server it never is, even for the public password", async () => {
    const local = await person({ email: `${randomUUID()}@this-browser.test`, password: LOCAL_ACCOUNT.password });
    const real = await person();
    process.env.ONDEN_BROWSER_APP = "1"; // what browser/env.ts sets, and nothing on a server does
    try {
      const { ticket } = await issueFreshProof(local.actor, "snapshot_export", { kind: "acknowledgement" });
      await consumeFreshProof(local.actor, "snapshot_export", ticket);
      // even there a person with a password of their own is never let through on a mere acknowledgement
      expect(await codeOf(issueFreshProof(real.actor, "snapshot_export", { kind: "acknowledgement" }))).toBe("fresh_proof_password_needed");
    } finally { delete process.env.ONDEN_BROWSER_APP; }
    // a server: the account whose password is the public string (moved over from the browser version without changing it) has to type it
    expect(await codeOf(issueFreshProof(local.actor, "snapshot_export", { kind: "acknowledgement" }))).toBe("fresh_proof_password_needed");
    expect(await rows(real.actor.id)).toEqual([]);
    await issueFreshProof(local.actor, "snapshot_export", { kind: "password", password: LOCAL_ACCOUNT.password }); // typing it is what a server asks
  });

  describe("wrong passwords are counted in the database", () => {
    const wrongOnce = (actor: ActorCtx) => codeOf(issueFreshProof(actor, "snapshot_export", { kind: "password", password: "wrong" }));
    const attempt = async (actorId: string) => (await q<{ failures: number; wait: number | null }>(
      `SELECT failures, CASE WHEN locked_until > now() THEN ceil(extract(epoch FROM locked_until - now()))::int END AS wait FROM fresh_proof_attempts WHERE actor_id = $1`, [actorId])).rows[0];

    it("five wrong in a row lock for 15 minutes, even the right password waits, nothing is handed out, and the lock is in the database", async () => {
      const { actor, password } = await person();
      for (let i = 0; i < 5; i++) expect(await wrongOnce(actor)).toBe("fresh_proof_wrong_password");
      const row = (await attempt(actor.id))!;
      expect(row.failures).toBe(5);
      expect(row.wait).toBeGreaterThan(14 * 60);
      expect(row.wait).toBeLessThanOrEqual(15 * 60);
      expect(await codeOf(issueFreshProof(actor, "snapshot_export", { kind: "password", password }))).toBe("fresh_proof_locked");
      expect(await rows(actor.id)).toEqual([]);
      expect((await attempt(actor.id))!.failures).toBe(5); // a refused-because-locked attempt is not counted again
      // another person is not held up by it
      const second = await person();
      await issueFreshProof(second.actor, "snapshot_export", { kind: "password", password: second.password });
    });

    it("each wrong attempt after a lock ends doubles it (a day at most); the attempt that locks leaves an event the owner can see, with no password in it", async () => {
      const { actor } = await person();
      for (let i = 0; i < 5; i++) await wrongOnce(actor);
      const ended = () => q(`UPDATE fresh_proof_attempts SET locked_until = now() - interval '1 second' WHERE actor_id = $1`, [actor.id]);
      await ended();
      expect(await wrongOnce(actor)).toBe("fresh_proof_wrong_password");
      expect((await attempt(actor.id))!.wait).toBeGreaterThan(29 * 60); // 6th: 30 minutes
      await ended();
      await wrongOnce(actor);
      expect((await attempt(actor.id))!.wait).toBeGreaterThan(59 * 60); // 7th: an hour
      await q(`UPDATE fresh_proof_attempts SET failures = 40, locked_until = now() - interval '1 second' WHERE actor_id = $1`, [actor.id]);
      await wrongOnce(actor);
      expect((await attempt(actor.id))!.wait).toBeLessThanOrEqual(24 * 3600); // never more than a day
      const events = (await q<{ target_id: string; payload: { failures: number; locked_for_seconds: number } }>(
        `SELECT target_id, payload FROM domain_events WHERE workspace_id = $1 AND event_type = 'FRESH_PROOF_LOCKED' AND target_id = $2 ORDER BY id`, [ws, actor.id])).rows;
      expect(events).toHaveLength(4); // the 5th, 6th, 7th and the 41st: each lock is recorded
      expect(events[0]!.payload).toEqual({ failures: 5, locked_for_seconds: 900 });
      expect(JSON.stringify(events)).not.toContain("wrong");
    });

    it("a right password clears the count, and right ones never use up the allowance of the wrong ones", async () => {
      const { actor, password } = await person();
      for (let i = 0; i < 4; i++) await wrongOnce(actor);
      await issueFreshProof(actor, "snapshot_export", { kind: "password", password });
      expect(await attempt(actor.id)).toBeUndefined(); // cleared
      for (let i = 0; i < 4; i++) expect(await wrongOnce(actor)).toBe("fresh_proof_wrong_password"); // four free again
      for (let i = 0; i < 12; i++) await issueFreshProof(actor, "snapshot_export", { kind: "password", password }); // a script of right ones is never locked
      expect(await attempt(actor.id)).toBeUndefined();
    });

    it("parallel guesses cannot get past the count: of twenty at once, five are checked (and wrong) and the rest are told they are locked", async () => {
      const { actor } = await person();
      const answers = await Promise.all(Array.from({ length: 20 }, () => wrongOnce(actor)));
      expect(answers.filter((a) => a === "fresh_proof_wrong_password")).toHaveLength(5);
      expect(answers.filter((a) => a === "fresh_proof_locked")).toHaveLength(15);
    });
  });

  describe("POST /api/fresh-proof", () => {
    const appFor = (actor: ActorCtx | null) => {
      const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
      app.onError(apiOnError);
      app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
      app.route("/api/fresh-proof", freshProofRouter);
      return app;
    };
    const post = (actor: ActorCtx | null, body: unknown) => appFor(actor).request("/api/fresh-proof", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    it("answers a ticket for a right password (no-store), 403 with a code for a wrong one (never 401: that means the sign-in is gone), and refuses a body with anything else in it", async () => {
      const { actor, password } = await person();
      const ok = await post(actor, { purpose: "snapshot_export", evidence: { kind: "password", password } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      const body = await ok.json() as { ticket: string; expires_in_seconds: number };
      expect(body.expires_in_seconds).toBe(120);
      await consumeFreshProof(actor, "snapshot_export", body.ticket);
      const wrong = await post(actor, { purpose: "snapshot_export", evidence: { kind: "password", password: "no" } });
      expect([wrong.status, (await wrong.json() as { error: string }).error]).toEqual([403, "fresh_proof_wrong_password"]);
      expect((await post(actor, { purpose: "snapshot_export", evidence: { kind: "password", password }, extra: 1 })).status).toBe(400);
      expect((await post(actor, { purpose: "full_backup", evidence: { kind: "password", password } })).status).toBe(400);
      expect([401, 403]).toContain((await post(null, { purpose: "snapshot_export", evidence: { kind: "acknowledgement" } })).status);
    });

    it("never writes a ticket to the log, in the answer to a refusal, or in an event", async () => {
      const spies = (["debug", "info", "warn", "error"] as const).map((level) => vi.spyOn(log, level).mockImplementation(() => undefined));
      const { actor, password } = await person();
      const res = await post(actor, { purpose: "snapshot_export", evidence: { kind: "password", password } });
      const { ticket } = await res.json() as { ticket: string };
      await consumeFreshProof(actor, "snapshot_export", ticket);
      const refused = await consumeFreshProof(actor, "snapshot_export", ticket).catch((error: unknown) => error as { message: string; code: string });
      expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(ticket);
      expect(JSON.stringify(refused)).not.toContain(ticket);
      expect(JSON.stringify((await q(`SELECT payload FROM domain_events WHERE workspace_id = $1`, [ws])).rows)).not.toContain(ticket);
      // a deliberately failing request: the password it carried, and a ticket in the header of a guarded request, are in no log, no answer and no event
      const secret = `Secret-${randomUUID()}`;
      const failed = await post(actor, { purpose: "snapshot_export", evidence: { kind: "password", password: secret } });
      expect(failed.status).toBe(403);
      for (let i = 0; i < 5; i++) await post(actor, { purpose: "snapshot_export", evidence: { kind: "password", password: secret } }); // reaches the lock and its event
      const answer = await failed.clone().text();
      const everything = JSON.stringify(spies.flatMap((spy) => spy.mock.calls)) + answer + JSON.stringify((await q(`SELECT payload, tx_meta FROM domain_events WHERE workspace_id = $1`, [ws])).rows);
      expect(everything).not.toContain(secret);
      expect(everything).not.toContain(ticket);
      // a failing GUARDED request carrying a ticket in the header (not the owner, so the route refuses it) and a failing spend of a made-up one:
      // neither value is in a log, an answer or an event
      const other = await person(); // (the first person is locked by the failing passwords above)
      const mine = await issueFreshProof(other.actor, "snapshot_export", { kind: "password", password: other.password });
      const bogus = `bogus-${randomUUID()}`;
      const guarded = new Hono<{ Variables: { actor: ActorCtx | null } }>();
      guarded.onError(apiOnError);
      guarded.use("*", async (c, next) => { c.set("actor", other.actor); await next(); });
      guarded.route("/api/snapshot", snapshotRouter);
      const refusedGet = await guarded.request("/api/snapshot", { headers: { [FRESH_PROOF_HEADER]: mine.ticket } });
      expect(refusedGet.status).toBe(403);
      const bogusRefusal = await consumeFreshProof(other.actor, "snapshot_export", bogus).catch((error: unknown) => error as { message: string; code: string });
      const guardedEverything = JSON.stringify(spies.flatMap((spy) => spy.mock.calls)) + await refusedGet.text() + JSON.stringify(bogusRefusal)
        + JSON.stringify((await q(`SELECT payload, tx_meta FROM domain_events WHERE workspace_id = $1`, [ws])).rows);
      expect(guardedEverything).not.toContain(mine.ticket);
      expect(guardedEverything).not.toContain(bogus);
      expect(guardedEverything).not.toContain(other.password);
      expect(FRESH_PROOF_HEADER).toBe("x-onden-fresh-proof");
    });
  });
});
