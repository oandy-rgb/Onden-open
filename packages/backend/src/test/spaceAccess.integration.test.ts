// The one access rule (spine/spaceAccess.ts), in the owner/member vocabulary
// (roles-owner-member proposal §3.3, §8.1): who reads / writes / manages which
// space, as a person and through an agent token.
//
//   read   = member (+ token: the space's external_ai is on)
//   write  = member with `edit` (+ token: access `write`)
//   manage = the workspace owner on a shared space; a person on their own
//            personal space; never a token
//
// The literal expectations are written by hand from that rule. The same
// question is asked of every way the app puts it (snapshot helper, spine
// `space` authority, space_write, any_space_write).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { persistActor, nativeOwnerActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { createToken } from "../services/agentTokens.js";
import { toolsForAccess } from "../services/agentTools/index.js";
import { assertAuthority } from "../spine/authority.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { updateSpace } from "../services/spaces.js";
import { currentAccessSnapshot, type AccessSnapshot, type AccessSubject } from "./helpers/accessSnapshot.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import type { ActorCtx } from "../types.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";

describe.skipIf(!isTestDatabase())("space access: owner / member vocabulary", () => {
  const stamp = Date.now();
  let WS = "";
  let owner: ActorCtx, mgr: ActorCtx, ed: ActorCtx, vw: ActorCtx, outsider: ActorCtx, bot: ActorCtx;
  let A = "", B = "", C = "", D = "", E = "";
  const personal: Record<string, string> = {};
  const tok: Record<string, string> = {};

  const sorted = (...ids: string[]) => [...ids].sort();
  const snap = (read: string[], write: string[], manage: string[]): AccessSnapshot =>
    ({ read: sorted(...read), write: sorted(...write), manage: sorted(...manage) });
  const person = (a: ActorCtx): AccessSubject => ({ actorId: a.id });
  const token = (key: string): AccessSubject => ({ actorId: bot.id, tokenId: tok[key]! });
  const tokenActor = (key: string) => resolveCurrentActor({ id: bot.id, tokenScope: { tokenId: tok[key]! } }, WS);
  let defaultSpace = "";
  // The spaces this file made: the snapshot asks about each one, not about every space the suite left in WS.
  const mine = () => [A, B, C, D, E, defaultSpace, ...Object.values(personal)];

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    owner = await persistActor(WS, { id: "", name: `sa-owner-${stamp}`, role: "admin", type: "human" });
    mgr = await persistActor(WS, { id: "", name: `sa-mgr-${stamp}`, role: "editor", type: "human" });
    ed = await persistActor(WS, { id: "", name: `sa-ed-${stamp}`, role: "editor", type: "human" });
    vw = await persistActor(WS, { id: "", name: `sa-vw-${stamp}`, role: "viewer", type: "human" });
    outsider = await persistActor(WS, { id: "", name: `sa-out-${stamp}`, role: "editor", type: "human" });
    bot = await persistActor(WS, { id: "", name: `sa-bot-${stamp}`, role: "editor", type: "agent" });
    defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    // Explicit membership only: the fixtures leave the default space.
    await q(`DELETE FROM space_members WHERE actor_id = ANY($1::uuid[]) AND space_id = $2`, [[owner, mgr, ed, vw, outsider, bot].map((a) => a.id), defaultSpace]);
    for (const a of [owner, mgr, ed, vw, outsider]) {
      personal[a.id] = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [a.id])).rows[0]!.id;
    }
    // A: AI on. B: AI off. C: AI on, mgr not in it. D: AI on, the agent only views.
    // E: AI on, the owner is NOT a member (decision 8: the owner must add self to read).
    A = await makeSpace(WS, `sa-A-${stamp}`, [
      { id: owner.id, permission: "edit" }, { id: mgr.id, permission: "edit" }, { id: ed.id, permission: "edit" },
      { id: vw.id, permission: "view" }, { id: bot.id, permission: "edit" }]);
    B = await makeSpace(WS, `sa-B-${stamp}`, [{ id: owner.id, permission: "edit" }, { id: ed.id, permission: "edit" }, { id: bot.id, permission: "edit" }],
      { publish: false, external_ai: false, backup: true });
    C = await makeSpace(WS, `sa-C-${stamp}`, [
      { id: owner.id, permission: "edit" }, { id: ed.id, permission: "edit" }, { id: vw.id, permission: "view" }, { id: bot.id, permission: "edit" }]);
    D = await makeSpace(WS, `sa-D-${stamp}`, [{ id: owner.id, permission: "edit" }, { id: bot.id, permission: "view" }]);
    E = await makeSpace(WS, `sa-E-${stamp}`, [{ id: mgr.id, permission: "edit" }, { id: bot.id, permission: "edit" }]);
    const mint = async (key: string, access: "read" | "write", extra: { issuedBy?: string } = {}) => {
      tok[key] = (await createToken(bot.id, { name: key, access, allowedTools: toolsForAccess(access), ...extra })).id;
    };
    await mint("write", "write");
    await mint("read", "read");
    await mint("issuedByVw", "write", { issuedBy: vw.id }); // the issuer no longer bounds the token
    await mint("revoked", "write");
    await q(`UPDATE agent_tokens SET revoked_at = now() WHERE id = $1`, [tok.revoked]);
    await mint("expired", "write");
    await q(`UPDATE agent_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1`, [tok.expired]);
  });

  // ── people ──────────────────────────────────────────────────────────────

  it("a person reads every space they belong to and writes where they have edit", async () => {
    expect(await currentAccessSnapshot(WS, person(ed), mine())).toEqual(snap([A, B, C, personal[ed.id]!], [A, B, C, personal[ed.id]!], [personal[ed.id]!]));
    expect(await currentAccessSnapshot(WS, person(vw), mine())).toEqual(snap([A, C, personal[vw.id]!], [personal[vw.id]!], [personal[vw.id]!]));
    expect(await currentAccessSnapshot(WS, person(outsider), mine())).toEqual(snap([personal[outsider.id]!], [personal[outsider.id]!], [personal[outsider.id]!]));
  });

  it("a member never manages a shared space, however they got in (§8.1.8: only the owner)", async () => {
    // mgr is an editing member of A and E and nothing more.
    expect(await currentAccessSnapshot(WS, person(mgr), mine())).toEqual(snap([A, E, personal[mgr.id]!], [A, E, personal[mgr.id]!], [personal[mgr.id]!]));
  });

  it("the owner manages every shared space but reads only the ones they belong to; never someone's personal space (§8.1.7)", async () => {
    const o = await currentAccessSnapshot(WS, person(owner), mine());
    expect(o.read).toEqual(sorted(A, B, C, D, personal[owner.id]!));
    expect(o.read).not.toContain(E);                   // not a member: cannot read it
    for (const s of [A, B, C, D, E, defaultSpace]) expect(o.manage).toContain(s);
    expect(o.manage).toContain(personal[owner.id]);
    for (const s of [mgr, ed, vw, outsider]) expect(o.manage).not.toContain(personal[s.id]);
    expect(o.write).not.toContain(E);
  });

  // ── tokens ──────────────────────────────────────────────────────────────

  it("a write token reaches its agent's spaces whose external_ai is on; it writes where the agent edits", async () => {
    // bot: A edit, B edit (AI off), C edit, D view, E edit.
    expect(await currentAccessSnapshot(WS, token("write"), mine())).toEqual(snap([A, C, D, E], [A, C, E], []));
  });

  it("a read token reads the same spaces and writes nowhere (§8.1.4)", async () => {
    expect(await currentAccessSnapshot(WS, token("read"), mine())).toEqual(snap([A, C, D, E], [], []));
  });

  it("the issuer no longer bounds a token: one issued by a view-only member still has the agent's reach", async () => {
    expect(await currentAccessSnapshot(WS, token("issuedByVw"), mine())).toEqual(snap([A, C, D, E], [A, C, E], []));
  });

  it("a revoked token and an expired token reach nothing", async () => {
    for (const key of ["revoked", "expired"]) expect(await currentAccessSnapshot(WS, token(key), mine()), key).toEqual(snap([], [], []));
  });

  it("a token is never a manager of anything and never the owner (§8.1.6)", async () => {
    const t = await tokenActor("write");
    await expect(assertAuthority(t, { kind: "space", spaceId: A, need: "read" })).rejects.toThrow();
    await expect(assertAuthority(t, { kind: "principal_admin" })).rejects.toThrow();
    await expect(assertAuthority(t, { kind: "review" })).rejects.toThrow(); // agents never review (§8.1.9)
  });

  // ── external_ai switch ──────────────────────────────────────────────────

  it("turning external_ai off cuts tokens at once and leaves people alone; turning it on opens only member spaces (§8.1.5)", async () => {
    const before = await currentAccessSnapshot(WS, token("write"), mine());
    expect(before.read).toContain(A);
    await updateSpace(owner, WS, A, { capabilities: { external_ai: false } });
    expect(await currentAccessSnapshot(WS, token("write"), mine())).toEqual(snap([C, D, E], [C, E], []));
    expect((await currentAccessSnapshot(WS, person(ed), mine())).read).toContain(A); // people are not affected
    await updateSpace(owner, WS, A, { capabilities: { external_ai: true } });
    expect(await currentAccessSnapshot(WS, token("write"), mine())).toEqual(before);
    await updateSpace(owner, WS, B, { capabilities: { external_ai: true } });
    expect(await currentAccessSnapshot(WS, token("write"), mine())).toEqual(snap([A, B, C, D, E], [A, B, C, E], [])); // B: bot is a member
    await updateSpace(owner, WS, B, { capabilities: { external_ai: false } });
    expect(await currentAccessSnapshot(WS, token("write"), mine())).toEqual(before);
  });

  // ── authority checks that read the same rule ────────────────────────────

  it("space authority: read < write < manage; managing is the owner's (shared) or the person's own (personal)", async () => {
    const may = (actor: ActorCtx, spaceId: string, need: "read" | "write" | "manage") =>
      assertAuthority(actor, { kind: "space", spaceId, need }).then(() => true, () => false);
    expect(await may(vw, A, "read")).toBe(true);
    expect(await may(vw, A, "write")).toBe(false);
    expect(await may(ed, A, "write")).toBe(true);
    expect(await may(ed, A, "manage")).toBe(false);
    expect(await may(mgr, A, "manage")).toBe(false);            // an editing member is not a manager
    expect(await may(mgr, C, "read")).toBe(false);              // not a member
    expect(await may(owner, E, "manage")).toBe(true);           // the owner intervenes in a shared space
    expect(await may(owner, E, "read")).toBe(true);             // …and the intervention covers every level
    expect(await may(owner, personal[ed.id]!, "read")).toBe(false); // never in someone's personal space
    expect(await may(ed, personal[ed.id]!, "manage")).toBe(true);
    expect(await may(outsider, personal[ed.id]!, "read")).toBe(false);
  });

  it("space_write and any_space_write follow the same write rule", async () => {
    const writeOk = (actor: ActorCtx, spaceId: string) => assertAuthority(actor, { kind: "space_write", spaceId }).then(() => true, () => false);
    expect(await writeOk(vw, A)).toBe(false);
    expect(await writeOk(ed, A)).toBe(true);
    const tw = await tokenActor("write");
    expect(await writeOk(tw, D)).toBe(false);                  // agent only views D
    expect(await writeOk(tw, A)).toBe(true);
    expect(await writeOk(tw, B)).toBe(false);                  // AI off
    expect(await writeOk(await tokenActor("read"), A)).toBe(false); // a read token writes nowhere
    const anyWrite = (actor: ActorCtx) => assertAuthority(actor, { kind: "any_space_write" }).then(() => true, () => false);
    expect(await anyWrite(vw)).toBe(true);                     // everyone writes in their personal space
    expect(await anyWrite(tw)).toBe(true);
    expect(await anyWrite(await tokenActor("read"))).toBe(false);
  });

  it("the owner is the workspace's owner row or the native System account; nobody inherits an ownerless workspace (§8.1.6)", async () => {
    const isOwner = (actor: ActorCtx) => assertAuthority(actor, { kind: "principal_admin" }).then(() => true, () => false);
    expect(await isOwner(owner)).toBe(true);
    expect(await isOwner(ed)).toBe(false);
    const admin2 = await persistActor(WS, { id: "", name: `sa-admin2-${stamp}`, role: "admin", type: "human" });
    // persistActor makes a human "admin" fixture the owner; hand it back to test the rule itself.
    await setWorkspaceOwner(WS, owner.id);
    expect(await isOwner(admin2)).toBe(false);
    await setWorkspaceOwner(WS, null);
    try {
      expect(await isOwner(admin2)).toBe(false);               // the old fallback (any admin) is gone
      expect(await isOwner(owner)).toBe(false);
      expect(await isOwner(await nativeOwnerActor(WS))).toBe(true); // the native app's System account is the owner there
    } finally {
      await setWorkspaceOwner(WS, owner.id);
    }
  });
});
