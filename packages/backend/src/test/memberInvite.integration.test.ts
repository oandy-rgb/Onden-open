// D110: adding a person is an invite with a ONE-TIME LINK. A sign-in claims
// the invited member — its spaces — only when it presents that link
// (valid, unused, unexpired) AND has the invited email. The email alone claims
// nothing. Real better-auth accounts + the assembled app; isolated *_test
// database only.
//
// This file runs with sign-up CLOSED (ONDEN_SIGNUP first-only, read when
// auth.ts loads): a sign-up carrying a valid link for its email may go ahead,
// anyone else may not.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as db from "../db.js";
import type { ActorCtx } from "../types.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";

let ws: string;
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
process.env.ONDEN_SIGNUP = "first-only";
const { auth } = await import("../auth.js");
const { app } = await import("../app.js");
const { createActor, updateActor, listActors, actorForSession, regenerateInvite, ActorAdminError } = await import("../services/actors.js");
const { setMember } = await import("../services/spaces.js");

type Invited = { id: string; invite_email: string; invite_pending: boolean; external_id: string | null; invite_token: string; invite_path: string };
type Roster = Array<{ id: string; invite_pending: boolean; invite_token_hash?: unknown; invite_token?: unknown }>;

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("member invites (D110)", () => {
  let owner: ActorCtx;
  let teamSpace: string;
  const tag = randomUUID().slice(0, 8);
  const mail = (who: string) => `${who}-${tag}@invite.test`;
  const password = `Test-${randomUUID()}!`;

  async function signIn(email: string): Promise<string> {
    const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    expect(res.status).toBe(200);
    return res.headers.getSetCookie().map(v => v.split(";", 1)[0]).join("; ");
  }
  const signUp = (name: string, email: string, token?: string) => auth.api.signUpEmail({
    body: { name, email, password },
    headers: new Headers(token ? { "x-onden-invite": token } : {}),
  });
  const post = (path: string, cookie: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const get = (path: string, cookie: string) => app.request(path, { headers: { Cookie: cookie } });
  const invite = (name: string, email: string) =>
    createActor(owner, async () => ({ name, type: "human", email })) as Promise<Invited>;
  const actorsByLogin = async (userId: string) =>
    (await db.q<{ id: string; name: string }>(
      "SELECT id, name FROM actors WHERE workspace_id=$1 AND external_id=$2", [ws, userId])).rows;
  const eventsOf = async (type: string, targetId: string) =>
    (await db.q<{ actor_id: string; payload: Record<string, unknown> }>(
      "SELECT actor_id, payload FROM domain_events WHERE workspace_id=$1 AND event_type=$2 AND target_id=$3", [ws, type, targetId])).rows;
  // Each test invites its own people (an address per test), so none relies
  // on an invite, sign-up or claim another test made.
  const invitedToTeam = async (name: string, email: string) => {
    const invited = await invite(name, email);
    await setMember(owner, ws, teamSpace, invited.id, "edit");
    return invited;
  };
  /** An invited member who signed up with the link and claimed it. */
  const claimedMember = async (who: string) => {
    const invited = await invitedToTeam("Bob", mail(who));
    const up = await signUp("Bob Smith", mail(who), invited.invite_token);
    const cookie = await signIn(mail(who));
    const res = await post("/api/invites/claim", cookie, { token: invited.invite_token });
    expect(res.status).toBe(200);
    return { invited, cookie, userId: up.user.id };
  };
  const pending = async (id: string) =>
    (await db.q<{ external_id: string | null; invite_used_at: Date | null }>(
      "SELECT external_id, invite_used_at FROM actors WHERE id=$1", [id])).rows[0]!;

  beforeAll(async () => {
    await (await auth.$context).runMigrations();
    // Sign-up is closed only once some account exists; on a fresh database
    // this one is it (other files' accounts serve on the shared one).
    await signUp("Seed", mail("seed")).catch(() => undefined);
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Member invites',$1) RETURNING id", [randomUUID()])).rows[0].id;
    // The first human becomes the workspace owner (trigger).
    owner = (await db.q<ActorCtx>(
      "INSERT INTO actors(workspace_id,name,type,external_id) VALUES($1,'Owner','human',$2) RETURNING id, name, type",
      [ws, `owner-${tag}`])).rows[0];
    teamSpace = await makeSpace(ws, "Team", [{ id: owner.id, permission: "edit" }]);
  }, 30000);

  afterAll(async () => {
    if (!ws) return;
    await deleteWorkspaceActors(ws);
    await db.q("DELETE FROM member_removals WHERE workspace_id=$1", [ws]);
  });

  it("a person needs an email; agents do not", async () => {
    const noEmail = createActor(owner, async () => ({ name: "Nobody", type: "human" }));
    await expect(noEmail).rejects.toMatchObject({ status: 400, body: { error: "email_required" } });
    const badEmail = createActor(owner, async () => ({ name: "Nobody", type: "human", email: "not-an-address" }));
    await expect(badEmail).rejects.toBeInstanceOf(ActorAdminError);
    await expect(badEmail).rejects.toMatchObject({ body: { error: "invalid_email" } });
    const agent = await createActor(owner, async () => ({ name: "Helper", type: "agent" })) as { id: string; invite_token?: string };
    expect(agent.id).toBeTruthy();
    expect(agent.invite_token).toBeUndefined();
    // A workspace role no longer exists: a client still sending one is told so, not ignored.
    const withRole = createActor(owner, async () => ({ name: "Roled", type: "human", email: mail("roled"), role: "admin" } as never));
    await expect(withRole).rejects.toMatchObject({ status: 400, body: { error: "role_removed" } });
  });

  it("inviting Bob returns his link once; only its hash is stored", async () => {
    const bob = await invite("Bob", `  ${mail("bob").toUpperCase()} `);
    expect(bob).toMatchObject({ invite_email: mail("bob"), invite_pending: true, external_id: null });
    expect(bob.invite_token).toMatch(/^ondi_/);
    expect(bob.invite_path).toBe(`/?invite=${encodeURIComponent(bob.invite_token)}`);
    await setMember(owner, ws, teamSpace, bob.id, "edit");
    const [row] = (await db.q<{ invite_token_hash: string }>("SELECT invite_token_hash FROM actors WHERE id=$1", [bob.id])).rows;
    expect(row!.invite_token_hash).not.toContain(bob.invite_token);
    expect(row!.invite_token_hash).toMatch(/^[0-9a-f]{64}$/);
    // Neither the address nor the link is in the log, nor in the roster.
    const created = JSON.stringify((await eventsOf("ACTOR_CREATED", bob.id))[0]?.payload);
    expect(created).not.toContain("@");
    expect(created).not.toContain("ondi_");
    const roster = await listActors(owner) as unknown as Roster;
    const listed = roster.find(a => a.id === bob.id)!;
    expect(listed.invite_pending).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("ondi_");
    expect(listed.invite_token_hash).toBeUndefined();
  });

  it("one waiting invite per address; two at once give one 409, not a 500", async () => {
    await invite("Ann", mail("ann"));
    await expect(invite("Ann again", mail("ann"))).rejects.toMatchObject({ status: 409, body: { error: "invite_email_taken" } });
    const race = await Promise.allSettled([invite("Twin A", mail("twin")), invite("Twin B", mail("twin"))]);
    expect(race.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const refused = race.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ status: 409, body: { error: "invite_email_taken" } });
  });

  it("closed sign-up: refused without a link, and with a link for another email", async () => {
    await expect(signUp("Stranger", mail("stranger"))).rejects.toMatchObject({ body: { code: "SIGNUP_CLOSED" } });
    const ivy = await invite("Ivy", mail("ivy"));
    // Ivy's email without her link.
    await expect(signUp("Ivy", mail("ivy"))).rejects.toMatchObject({ body: { code: "SIGNUP_CLOSED" } });
    // Ivy's link with someone else's email.
    await expect(signUp("Mallory", mail("mallory"), ivy.invite_token)).rejects.toMatchObject({ body: { code: "INVITE_EMAIL_MISMATCH" } });
  });

  it("the right email WITHOUT the link claims nothing: it falls through to a new member in no shared space", async () => {
    const carol = await invite("Carol", mail("carol"));
    const loginId = `carol-login-${tag}`;
    const resolved = await actorForSession({ id: loginId, name: "Carol", email: mail("carol") }, ws);
    expect(resolved.id).not.toBe(carol.id);
    const sharedMemberships = await db.q(
      `SELECT 1 FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE m.actor_id = $1 AND s.kind = 'shared'`, [resolved.id]);
    expect(sharedMemberships.rows).toHaveLength(0);
    expect(await pending(carol.id)).toMatchObject({ external_id: null, invite_used_at: null });
    // Her link afterwards meets a login that is already a member here.
    await expect(actorForSession({ id: loginId, name: "Carol", email: mail("carol") }, ws, { inviteToken: carol.invite_token }))
      .rejects.toMatchObject({ code: "already_member", status: 409 });
  });

  it("Bob signs up with his link and claims the invited member through POST /api/invites/claim", async () => {
    const bob = await invitedToTeam("Bob", mail("bob-claim"));
    const up = await signUp("Bob Smith", mail("bob-claim"), bob.invite_token);
    const bobCookie = await signIn(mail("bob-claim"));
    const res = await post("/api/invites/claim", bobCookie, { token: bob.invite_token });
    expect(res.status).toBe(200);
    expect((await res.json() as { actor: { id: string } }).actor).toMatchObject({ id: bob.id });
    // The same row, the owner's spaces; no second actor.
    expect(await actorsByLogin(up.user.id)).toEqual([{ id: bob.id, name: "Bob Smith" }]);
    const spaces = await get("/api/spaces", bobCookie);
    expect((await spaces.json() as { spaces: Array<{ id: string }> }).spaces.map(s => s.id)).toContain(teamSpace);
    const claimed = await eventsOf("ACTOR_CLAIMED", bob.id);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.actor_id).toBe(bob.id);
    expect((await pending(bob.id)).invite_used_at).not.toBeNull();
    expect((await listActors(owner) as unknown as Roster).find(a => a.id === bob.id)?.invite_pending).toBe(false);
    // A retried claim (lost response) answers with the same member.
    const again = await post("/api/invites/claim", bobCookie, { token: bob.invite_token });
    expect(again.status).toBe(200);
    expect(await eventsOf("ACTOR_CLAIMED", bob.id)).toHaveLength(1);
    // A claim without a link from a member is refused, not a new member.
    const empty = await post("/api/invites/claim", bobCookie, {});
    expect(empty.status).toBe(409);
    expect(await empty.json()).toEqual({ error: "already_member" });
  });

  it("a used link is refused for any other login", async () => {
    const { invited: bob } = await claimedMember("bob-used");
    await expect(actorForSession({ id: `other-${tag}`, name: "Other", email: mail("bob-used") }, ws, { inviteToken: bob.invite_token }))
      .rejects.toMatchObject({ code: "invite_used", status: 410 });
    expect(await actorsByLogin(`other-${tag}`)).toEqual([]);
  });

  it("a link presented with a different email is refused and the invite stays", async () => {
    const dave = await invite("Dave", mail("dave"));
    await expect(actorForSession({ id: `eve-${tag}`, name: "Eve", email: mail("eve") }, ws, { inviteToken: dave.invite_token }))
      .rejects.toMatchObject({ code: "invite_email_mismatch", status: 403 });
    expect(await actorsByLogin(`eve-${tag}`)).toEqual([]);
    expect(await pending(dave.id)).toMatchObject({ external_id: null, invite_used_at: null });
  });

  it("an expired link is refused, at sign-up and at the claim", async () => {
    const gil = await invite("Gil", mail("gil"));
    await db.q("UPDATE actors SET invite_expires_at = now() - interval '1 minute' WHERE id=$1", [gil.id]);
    await expect(signUp("Gil", mail("gil"), gil.invite_token)).rejects.toMatchObject({ body: { code: "INVITE_EXPIRED" } });
    await expect(actorForSession({ id: `gil-${tag}`, name: "Gil", email: mail("gil") }, ws, { inviteToken: gil.invite_token }))
      .rejects.toMatchObject({ code: "invite_expired", status: 410 });
    expect(await pending(gil.id)).toMatchObject({ external_id: null });
  });

  it("regenerating the link invalidates the old one; the new one claims", async () => {
    const frank = await invite("Frank", mail("frank"));
    await setMember(owner, ws, teamSpace, frank.id, "view");
    const renewed = await regenerateInvite(owner, frank.id);
    expect(renewed.invite_token).not.toBe(frank.invite_token);
    expect(await eventsOf("ACTOR_INVITE_RENEWED", frank.id)).toHaveLength(1);
    await expect(actorForSession({ id: `frank-${tag}`, name: "Frank", email: mail("frank") }, ws, { inviteToken: frank.invite_token }))
      .rejects.toMatchObject({ code: "invite_invalid", status: 404 });
    const claimed = await actorForSession({ id: `frank-${tag}`, name: "Frank", email: mail("frank") }, ws, { inviteToken: renewed.invite_token });
    expect(claimed).toMatchObject({ id: frank.id });
    // The claim keeps the permission the owner gave the invited row.
    expect((await db.q<{ permission: string }>(
      "SELECT permission FROM space_members WHERE actor_id = $1 AND space_id = $2", [frank.id, teamSpace])).rows[0]?.permission).toBe("view");
    // Claimed: no more links for that row.
    await expect(regenerateInvite(owner, frank.id)).rejects.toMatchObject({ status: 409, body: { error: "invite_not_pending" } });
  });

  it("a rename by the owner sticks across Bob's later requests", async () => {
    const { invited: bob, cookie: bobCookie } = await claimedMember("bob-renamed");
    await updateActor(owner, bob.id, async () => ({ name: "Robert" }));
    expect((await get("/api/spaces", bobCookie)).status).toBe(200);
    expect((await get("/api/spaces", bobCookie)).status).toBe(200);
    const [row] = (await db.q<{ name: string }>("SELECT name FROM actors WHERE id=$1", [bob.id])).rows;
    expect(row!.name).toBe("Robert");
  });

  it("a fresh sign-in without an invite makes a plain member and records ACTOR_CREATED", async () => {
    const userId = `fresh-${tag}`;
    const fresh = await actorForSession({ id: userId, name: "Fresh", email: mail("fresh") }, ws);
    expect(fresh).toMatchObject({ type: "human", name: "Fresh" });
    const created = await eventsOf("ACTOR_CREATED", fresh.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actor_id: fresh.id, payload: { signup: true } });
    // The second resolution finds the same actor; nothing new is recorded.
    expect((await actorForSession({ id: userId, name: "Renamed upstream", email: null }, ws)).id).toBe(fresh.id);
    expect(await eventsOf("ACTOR_CREATED", fresh.id)).toHaveLength(1);
  });

  it("a removed member's new invite link lets them back in", async () => {
    const userId = `removed-${tag}`;
    const email = mail("removed");
    await db.q("INSERT INTO member_removals (workspace_id, external_id) VALUES ($1, $2)", [ws, userId]);
    await expect(actorForSession({ id: userId, name: "Removed", email }, ws)).rejects.toThrow("membership_removed");
    const back = await invite("Back", email);
    const resolved = await actorForSession({ id: userId, name: "Removed", email }, ws, { inviteToken: back.invite_token });
    expect(resolved).toMatchObject({ id: back.id });
    expect((await db.q("SELECT 1 FROM member_removals WHERE workspace_id=$1 AND external_id=$2", [ws, userId])).rows).toHaveLength(0);
  });
});
