// Model-based random test of permission STATE CHANGING over time.
//
// permissionMatrix.test.ts (reads) and writePermissionMatrix.integration.test.ts
// (writes) sweep every route for a FIXED world. What they cannot catch is a
// permission that changes between two requests (on 2026-10-23 a role-field
// change made every note read-only in production). Here fast-check generates a
// sequence of commands that mixes state changes with probes, runs them through
// the REAL routes and the MCP tool gate, and compares every outcome with a
// small reference model written from docs/architecture/proposals/
// roles-owner-member-2026-10-22.md §3.3 (spine/spaceAccess.ts header):
//
//   read(actor, S)  = member of S                       (token: and S.external_ai on)
//   write(actor, S) = read ∧ permission 'edit'          (token: and its access is 'write')
//   manage          = the workspace owner, on a shared space; never a token
//
// Model. Spaces (members and their view/edit permission, the "AI can read"
// switch), notes (space, parent, title, body, deleted, tagged), the agent's
// tokens (access, revoked). Actors: the owner, members A and B, and one agent
// G reached through up to two bearer tokens. The owner is a member (edit) of
// every space they create and is never removed from one, so "owner steps into
// a space" is not exercised here.
//
// State commands (all by the owner, via the real routes): create a space,
// create a note, add / change / remove a member (A, B or the agent), switch
// "AI can read", mint / revoke / re-access a token, move a note with its subtree.
// Probes (by a random actor, the model predicts the outcome): read a note,
// bootstrap / membership / sync delta listings, the spaces list, edit the
// body, rename, tag / untag, move, delete, restore, MCP read and write tools,
// and a non-owner trying to manage a space.
//
// Invariants, checked after EVERY command:
//   1. a probe is allowed and effective, or refused (403/404; 401 for a
//      revoked token) with no state change;
//   2. the database equals the model (note rows, tags, members, switches,
//      token rows), so a refused probe changed nothing and an allowed one
//      changed exactly what the model says;
//   3. listings and MCP results contain exactly the notes the model says the
//      actor can see (bootstrap, membership stream, sync delta upserts and
//      revocations, getNode);
//   4. after a permission change the affected actor's very next reads already
//      follow the new state (each state command ends with a read sweep);
//   5. the permission fields the frontend uses (GET /api/spaces:
//      permission, can_manage, capabilities, is_owner; bootstrap
//      actor_is_owner; node space_id) match the model, so a renamed field
//      fails here too.
//
// Run count and seed: PROPS_RUNS (default 12 here, ~1 minute) and PROPS_SEED
// (helpers/propsConfig.ts). A failure prints the seed, the shrunk command
// sequence and the replay line:
//   PROPS_SEED=123 PROPS_RUNS=60 npx vitest run src/test/properties/permissions.property.integration.test.ts
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import fc from "fast-check";
import { q, getWorkspaceId } from "../../db.js";
import { setWorkspaceOwner } from "../helpers/setOwner.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { checkAsync, PROPS_SEED } from "../helpers/propsConfig.js";
import { _resetRateLimits } from "../../services/agentTools/rateLimit.js";

// ── Controllable session (better-auth mocked; identity resolved from the REAL
//    actors table via external_id, as in writePermissionMatrix) ──────────────
let sessionExternalId: string | null = null;
vi.mock("../../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: {
      getSession: vi.fn(async () =>
        sessionExternalId
          ? { user: { id: sessionExternalId, name: "Perm Props", email: `${sessionExternalId}@props.test` } }
          : null),
    },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../../app.js");

// ── Vocabulary ───────────────────────────────────────────────────────────────
type Perm = "view" | "edit";
/** Who is a member of a space: the three people and the agent. */
type Member = "owner" | "A" | "B" | "G";
/** Who sends a request: a person's session, or one of the agent's two bearer tokens. */
type Who = "owner" | "A" | "B" | "tok0" | "tok1";
const WHO: Who[] = ["owner", "A", "B", "tok0", "tok1"];
type Access = "read" | "write";

type MSpace = { id: string; externalAi: boolean; members: Map<Member, Perm> };
type MNote = { id: string; space: string; parent: string | null; title: string; body: string; deleted: boolean; deletedBy: string | null; tagged: boolean };
type MToken = { id: string; plaintext: string; access: Access; revoked: boolean };
type Model = { spaces: MSpace[]; notes: MNote[]; tokens: Array<MToken | null>; counter: number };
type Real = { ws: string; ext: Record<"owner" | "A" | "B", string>; ids: Record<Member, string>; tagId: string; baseline: number };

const newModel = (): Model => ({ spaces: [], notes: [], tokens: [null, null], counter: 0 });
const isTok = (w: Who): w is "tok0" | "tok1" => w === "tok0" || w === "tok1";
const slotOf = (w: "tok0" | "tok1") => (w === "tok0" ? 0 : 1);
const memberOf = (w: Who): Member => (isTok(w) ? "G" : w);

// ── The reference model: the rule, written once ─────────────────────────────
const spaceOf = (m: Model, id: string) => m.spaces.find((s) => s.id === id)!;
const tokenOf = (m: Model, w: Who) => (isTok(w) ? m.tokens[slotOf(w)] : null);
const revoked = (m: Model, w: Who) => isTok(w) && (tokenOf(m, w)?.revoked ?? true);

function canReadIn(m: Model, w: Who, space: string): boolean {
  if (revoked(m, w)) return false;
  const s = spaceOf(m, space);
  if (!s.members.has(memberOf(w))) return false;
  return !isTok(w) || s.externalAi;
}
function canWriteIn(m: Model, w: Who, space: string): boolean {
  if (!canReadIn(m, w, space)) return false;
  if (spaceOf(m, space).members.get(memberOf(w)) !== "edit") return false;
  return !isTok(w) || tokenOf(m, w)!.access === "write";
}
const visible = (m: Model, w: Who, n: MNote) => !n.deleted && canReadIn(m, w, n.space);
const writable = (m: Model, w: Who, n: MNote) => !n.deleted && canWriteIn(m, w, n.space);
const visibleIds = (m: Model, w: Who) => m.notes.filter((n) => visible(m, w, n)).map((n) => n.id);
const subtreeOf = (m: Model, root: MNote): MNote[] => {
  const out = [root];
  for (let i = 0; i < out.length; i++) out.push(...m.notes.filter((n) => n.parent === out[i]!.id));
  return out;
};

// ── Requests ─────────────────────────────────────────────────────────────────
type Res = { status: number; json: any };

async function call(r: Real, m: Model, who: Who, method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (isTok(who)) {
    headers.authorization = `Bearer ${tokenOf(m, who)!.plaintext}`;
    await _resetRateLimits(); // 60 tool calls / minute / agent: a model run makes more
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  sessionExternalId = isTok(who) ? null : r.ext[who];
  try {
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json };
  } finally {
    sessionExternalId = null;
  }
}
const tool = (r: Real, m: Model, who: Who, name: string, args: unknown) =>
  call(r, m, who, "POST", `/api/mcp/tools/${name}`, args);

class ModelMismatch extends Error {}
const fail = (what: string): never => { throw new ModelMismatch(what); };
const is2xx = (s: number) => s >= 200 && s < 300;

/** The outcome the model predicts: allowed and effective, or refused. A refusal
 *  is 403 or 404 (401 for a revoked token); never a 2xx, never a 5xx. */
const tally = { allowed: 0, refused: 0, revoked: 0 };
function expectOutcome(what: string, res: Res, allowed: boolean, revokedToken: boolean): void {
  tally[revokedToken ? "revoked" : allowed ? "allowed" : "refused"]++;
  const seen = `${what}: got ${res.status} ${JSON.stringify(res.json)?.slice(0, 160)}`;
  if (revokedToken) { if (res.status !== 401) fail(`${seen}; a revoked token must be refused with 401`); return; }
  if (allowed) { if (!is2xx(res.status)) fail(`${seen}; the model says this is allowed`); return; }
  if (res.status !== 403 && res.status !== 404) fail(`${seen}; the model says this is refused (403/404)`);
}

// ── The database must equal the model ───────────────────────────────────────
const stripBlockIds = (s: string) => s.replace(/[ \t]*\^[\w-]+[ \t]*$/gm, "").trimEnd();

async function assertDatabaseMatchesModel(m: Model, ctx: string): Promise<void> {
  if (m.notes.length) {
    const rows = (await q<{ id: string; title: string; markdown: string; space_id: string; parent_id: string | null; deleted: boolean; tagged: boolean }>(
      `SELECT n.id::text, n.title, n.markdown, n.space_id::text, n.parent_id::text, (n.deleted_at IS NOT NULL) AS deleted,
              EXISTS (SELECT 1 FROM node_tags t WHERE t.node_id = n.id) AS tagged
         FROM content_nodes n WHERE n.id = ANY($1::uuid[])`, [m.notes.map((n) => n.id)])).rows;
    for (const n of m.notes) {
      const row = rows.find((x) => x.id === n.id);
      if (!row) { fail(`${ctx}: note ${n.title} is missing from the database`); continue; }
      const diff = [
        row.title !== n.title && `title ${row.title} ≠ ${n.title}`,
        stripBlockIds(row.markdown) !== n.body && `body ${JSON.stringify(row.markdown)} ≠ ${JSON.stringify(n.body)}`,
        row.space_id !== n.space && `space differs`,
        row.parent_id !== n.parent && `parent differs`,
        row.deleted !== n.deleted && `deleted ${row.deleted} ≠ ${n.deleted}`,
        row.tagged !== n.tagged && `tagged ${row.tagged} ≠ ${n.tagged}`,
      ].filter(Boolean);
      if (diff.length) fail(`${ctx}: database differs from the model for ${n.title}: ${diff.join("; ")}`);
    }
  }
  for (const s of m.spaces) {
    const members = (await q<{ actor_id: string; permission: Perm }>(
      `SELECT actor_id::text, permission FROM space_members WHERE space_id = $1`, [s.id])).rows;
    const real = new Map(members.map((x) => [x.actor_id, x.permission]));
    const want = [...s.members].map(([k, p]) => `${k}:${p}`).sort().join(",");
    const have = [...real].map(([id, p]) => `${Object.entries(currentIds).find(([, v]) => v === id)?.[0] ?? id}:${p}`).sort().join(",");
    if (want !== have) fail(`${ctx}: members of a space are ${have}, the model says ${want}`);
    const ai = (await q<{ ai: string | null }>(`SELECT capabilities->>'external_ai' AS ai FROM spaces WHERE id = $1`, [s.id])).rows[0]?.ai;
    if ((ai === "true") !== s.externalAi) fail(`${ctx}: external_ai is ${ai}, the model says ${s.externalAi}`);
  }
  for (const t of m.tokens) {
    if (!t) continue;
    const row = (await q<{ access: string; revoked: boolean }>(
      `SELECT access, (revoked_at IS NOT NULL) AS revoked FROM agent_tokens WHERE id = $1`, [t.id])).rows[0];
    if (!row || row.access !== t.access || row.revoked !== t.revoked) fail(`${ctx}: token row ${JSON.stringify(row)} differs from the model ${t.access}/${t.revoked}`);
  }
}
let currentIds: Record<Member, string> = { owner: "", A: "", B: "", G: "" };

// ── Reads: one note, listings, spaces ───────────────────────────────────────

/** Read one note as `who` and compare with the model (REST for people, getNode for tokens). */
async function probeRead(r: Real, m: Model, who: Who, n: MNote): Promise<void> {
  const want = visible(m, who, n);
  const label = `${who} reads ${n.title}`;
  if (isTok(who)) {
    const res = await tool(r, m, who, "getNode", { id: n.id });
    if (revoked(m, who)) return expectOutcome(label, res, false, true);
    if (res.status !== 200) fail(`${label}: got ${res.status}`);
    const got = res.json?.result?.id ?? null;
    if (want && got !== n.id) fail(`${label}: the model says it is readable, getNode returned ${JSON.stringify(res.json?.result)?.slice(0, 80)}`);
    if (!want && got !== null) fail(`${label}: getNode returned a note the model says this token cannot see`);
    return;
  }
  const res = await call(r, m, who, "GET", `/api/nodes/${n.id}`);
  if (want) {
    if (res.status !== 200 || res.json?.id !== n.id) fail(`${label}: the model says it is readable, got ${res.status}`);
    if (res.json.space_id !== n.space) fail(`${label}: space_id ${res.json.space_id} ≠ model ${n.space}`);
  } else if (res.status !== 404) fail(`${label}: the model says it is not visible, got ${res.status} (404 expected: no oracle)`);
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** A listing's note ids, limited to the notes this run made, must be exactly what `who` can see. */
function assertListing(label: string, m: Model, who: Who, got: string[]): void {
  const mine = new Set(m.notes.map((n) => n.id));
  const seen = got.filter((id) => mine.has(id));
  const want = visibleIds(m, who);
  if (!sameSet(seen, want)) {
    const extra = seen.filter((id) => !want.includes(id)).map((id) => m.notes.find((n) => n.id === id)!.title);
    const missing = want.filter((id) => !seen.includes(id)).map((id) => m.notes.find((n) => n.id === id)!.title);
    fail(`${label}: shows [${extra.join(",")}] the model says ${who} cannot see; is missing [${missing.join(",")}]`);
  }
}

async function probeListings(r: Real, m: Model, who: Who): Promise<void> {
  if (isTok(who)) {
    // A token reaches only /api/mcp: the "listing" is getNode over every note, plus the tool list.
    for (const n of m.notes) await probeRead(r, m, who, n);
    const res = await call(r, m, who, "GET", "/api/mcp/tools");
    if (revoked(m, who)) return expectOutcome(`${who} lists tools`, res, false, true);
    const names: string[] = (res.json?.tools ?? []).map((t: { name: string }) => t.name);
    const writes = ["updateNode", "createNode", "applyTag", "removeTag"];
    const has = writes.filter((w) => names.includes(w));
    const want = tokenOf(m, who)!.access === "write" ? writes : [];
    if (!sameSet(has, want)) fail(`${who} tool list has write tools [${has}], the model (access ${tokenOf(m, who)!.access}) says [${want}]`);
    const blocked = await call(r, m, who, "GET", "/api/bootstrap");
    expectOutcome(`${who} GET /api/bootstrap`, blocked, false, false);
    return;
  }
  const boot = await call(r, m, who, "GET", "/api/bootstrap");
  if (boot.status !== 200) fail(`${who} bootstrap: ${boot.status}`);
  assertListing(`${who} bootstrap`, m, who, (boot.json.nodes as Array<{ id: string; space_id: string }>).map((n) => n.id));
  for (const row of boot.json.nodes as Array<{ id: string; space_id: string }>) {
    const n = m.notes.find((x) => x.id === row.id);
    if (n && row.space_id !== n.space) fail(`${who} bootstrap: ${n.title} has space_id ${row.space_id}, the model says ${n.space}`);
  }
  if (boot.json.actor_is_owner !== (who === "owner")) fail(`${who} bootstrap: actor_is_owner is ${boot.json.actor_is_owner}`);

  const ids: string[] = [];
  let cursor = "";
  for (let page = 0; page < 50; page++) {
    const res = await call(r, m, who, "GET", `/api/sync/membership?limit=500&cursor=${cursor}`);
    if (res.status !== 200 || res.json?.retry_required) fail(`${who} membership page: ${res.status} ${JSON.stringify(res.json)?.slice(0, 80)}`);
    ids.push(...res.json.ids);
    if (!res.json.next_cursor) break;
    cursor = res.json.next_cursor;
  }
  assertListing(`${who} sync membership`, m, who, ids);

  // The delta since the start of the run: no unreadable upsert, every unreadable held id revoked.
  const known = m.notes.map((n) => n.id);
  const delta = await call(r, m, who, "POST", "/api/sync", { since: r.baseline, known });
  if (delta.status !== 200) fail(`${who} sync delta: ${delta.status}`);
  const upserts = (delta.json.nodes.upsert as Array<{ id: string }>).map((n) => n.id);
  for (const id of upserts) {
    const n = m.notes.find((x) => x.id === id);
    if (n && !visible(m, who, n)) fail(`${who} sync delta upsert carries ${n.title}, which the model says ${who} cannot see`);
  }
  for (const n of m.notes) {
    if (!visible(m, who, n) && !(delta.json.nodes.delete as string[]).includes(n.id)) {
      fail(`${who} sync delta: held note ${n.title} is no longer visible but was not revoked`);
    }
  }
  const plain = await call(r, m, who, "GET", `/api/sync?since=${r.baseline}`);
  for (const row of plain.json.nodes.upsert as Array<{ id: string }>) {
    const n = m.notes.find((x) => x.id === row.id);
    if (n && !visible(m, who, n)) fail(`${who} GET /api/sync carries ${n.title}, which the model says ${who} cannot see`);
  }
}

/** GET /api/spaces: the fields the frontend uses to decide what to offer. */
async function probeSpaces(r: Real, m: Model, who: Who): Promise<void> {
  const res = await call(r, m, who, "GET", "/api/spaces");
  if (isTok(who)) return expectOutcome(`${who} GET /api/spaces`, res, false, revoked(m, who));
  if (res.status !== 200) fail(`${who} GET /api/spaces: ${res.status}`);
  if (res.json.is_owner !== (who === "owner")) fail(`${who} spaces: is_owner is ${res.json.is_owner}`);
  const rows = res.json.spaces as Array<{ id: string; kind: string; permission: Perm | null; can_manage: boolean; capabilities: Record<string, boolean> }>;
  for (const s of m.spaces) {
    const row = rows.find((x) => x.id === s.id);
    const mine = s.members.get(memberOf(who));
    if (!mine && who !== "owner") { if (row) fail(`${who} spaces: lists a space the model says ${who} is not in`); continue; }
    if (!row) { fail(`${who} spaces: a space the model says ${who} is in is missing`); continue; }
    if (row.permission !== (mine ?? null)) fail(`${who} spaces: permission is ${row.permission}, the model says ${mine}`);
    if (row.can_manage !== (who === "owner")) fail(`${who} spaces: can_manage is ${row.can_manage}`);
    if ((row.capabilities?.external_ai === true) !== s.externalAi) fail(`${who} spaces: capabilities.external_ai is ${row.capabilities?.external_ai}`);
    if (row.kind !== "shared") fail(`${who} spaces: kind is ${row.kind}`);
  }
}

// ── Writes: the same probe for people (REST) and tokens (MCP) ───────────────

async function probeEdit(r: Real, m: Model, who: Who, n: MNote, what: "body" | "title"): Promise<void> {
  const k = ++m.counter;
  const allowed = writable(m, who, n);
  const label = `${who} edits ${what} of ${n.title}`;
  const value = what === "body" ? `body ${k}` : `title ${k}`;
  let res: Res;
  if (isTok(who)) {
    const base = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [n.id])).rows[0]!.markdown;
    res = await tool(r, m, who, "updateNode", what === "body" ? { id: n.id, markdown: value, base_markdown: base } : { id: n.id, title: value });
  } else {
    res = await call(r, m, who, "PATCH", `/api/nodes/${n.id}`, what === "body" ? { markdown: value } : { title: value });
  }
  expectOutcome(label, res, allowed, revoked(m, who));
  if (allowed) { if (what === "body") n.body = value; else n.title = value; }
}

async function probeTag(r: Real, m: Model, who: Who, n: MNote): Promise<void> {
  const allowed = writable(m, who, n);
  const label = `${who} ${n.tagged ? "removes the tag from" : "tags"} ${n.title}`;
  let res: Res;
  if (isTok(who)) res = await tool(r, m, who, n.tagged ? "removeTag" : "applyTag", { nodeId: n.id, tagId: r.tagId });
  else res = await call(r, m, who, n.tagged ? "DELETE" : "PUT", `/api/nodes/${n.id}/tags/${r.tagId}`);
  expectOutcome(label, res, allowed, revoked(m, who));
  if (allowed) n.tagged = !n.tagged;
}

async function probeDelete(r: Real, m: Model, who: Who, n: MNote): Promise<void> {
  // MCP has no delete tool and a token may not use REST: a token's delete is always refused.
  const allowed = !isTok(who) && writable(m, who, n);
  const res = await call(r, m, who, "DELETE", `/api/nodes/${n.id}`);
  expectOutcome(`${who} deletes ${n.title}`, res, allowed, revoked(m, who));
  if (allowed) for (const d of subtreeOf(m, n).filter((x) => !x.deleted)) { d.deleted = true; d.deletedBy = n.id; }
}

async function probeUndelete(r: Real, m: Model, who: Who, n: MNote): Promise<void> {
  // A deleted note comes back for an editor of its space (not through a token).
  const allowed = !isTok(who) && canWriteIn(m, who, n.space);
  const res = await call(r, m, who, "POST", `/api/nodes/${n.id}/undelete`);
  expectOutcome(`${who} restores ${n.title}`, res, allowed, revoked(m, who));
  if (allowed) for (const d of m.notes.filter((x) => x.deletedBy === n.id)) { d.deleted = false; d.deletedBy = null; }
}

async function probeMove(r: Real, m: Model, who: Who, n: MNote, to: MSpace): Promise<void> {
  // Moving needs edit in the target and the owner's hand on the source space; a
  // token cannot move. In this model only the owner qualifies.
  const allowed = who === "owner" && !n.deleted;
  const epoch = (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [r.ws])).rows[0]!.e;
  const res = await call(r, m, who, "POST", "/api/spaces/move", { node_id: n.id, to_space_id: to.id, membership_epoch: epoch });
  expectOutcome(`${who} moves ${n.title} to another space`, res, allowed, revoked(m, who));
  if (allowed) {
    for (const d of subtreeOf(m, n)) d.space = to.id;
    n.parent = null;
  }
}

/** A person who is not the owner (or a token) tries to manage a space: refused, nothing changes. */
async function probeManage(r: Real, m: Model, who: Who, s: MSpace, kind: "join" | "ai" | "rename"): Promise<void> {
  const label = `${who} tries to manage a space (${kind})`;
  let res: Res;
  if (kind === "join") res = await call(r, m, who, "PUT", `/api/spaces/${s.id}/members/${r.ids[memberOf(who)]}`, { permission: "edit" });
  else if (kind === "ai") res = await call(r, m, who, "PATCH", `/api/spaces/${s.id}`, { capabilities: { external_ai: !s.externalAi } });
  else res = await call(r, m, who, "PATCH", `/api/spaces/${s.id}`, { name: `renamed by ${who}` });
  expectOutcome(label, res, false, revoked(m, who));
}

// ── Commands ─────────────────────────────────────────────────────────────────
type Cmd = fc.AsyncCommand<Model, Real>;

const pick = <T>(xs: T[], i: number): T => xs[i % xs.length]!;
const spaceNames = (m: Model) => m.spaces.map((s, i) => `space${i}`);

/** Reads that must already follow a permission change: every note, as each given actor. */
async function sweepReads(r: Real, m: Model, who: Who[]): Promise<void> {
  for (const w of who) {
    if (isTok(w) && !tokenOf(m, w)) continue;
    for (const n of m.notes) await probeRead(r, m, w, n);
  }
}
const everyone = (m: Model): Who[] => WHO.filter((w) => !isTok(w) || tokenOf(m, w));

/** A command: a readable name for the shrunk sequence, a precondition on the model, a body. */
function command(name: string, check: (m: Model) => boolean, run: (m: Model, r: Real) => Promise<void>): Cmd {
  return {
    check,
    async run(m, r) {
      try {
        await run(m, r);
        await assertDatabaseMatchesModel(m, name);
      } catch (e) {
        if (e instanceof ModelMismatch) throw new ModelMismatch(`${name}\n    ${e.message}`);
        throw e;
      }
    },
    toString: () => name,
  };
}

// state --------------------------------------------------------------------
const createSpace = () => command("owner creates a space", (m) => m.spaces.length < 3, async (m, r) => {
  const res = await call(r, m, "owner", "POST", "/api/spaces", { name: `props space ${++m.counter}` });
  if (res.status !== 201) fail(`create space: ${res.status} ${JSON.stringify(res.json)}`);
  m.spaces.push({ id: res.json.id, externalAi: false, members: new Map([["owner", "edit"]]) });
});

const createNote = (si: number, withParent: boolean, pi: number) => command(`owner creates a note (in space ${si}${withParent ? ", under a note" : ""})`,
  (m) => m.spaces.length > 0 && m.notes.length < 7, async (m, r) => {
    const s = pick(m.spaces, si);
    const parents = m.notes.filter((n) => !n.deleted && n.space === s.id);
    const parent = withParent && parents.length ? pick(parents, pi) : null;
    const k = ++m.counter;
    const res = await call(r, m, "owner", "POST", "/api/nodes", { title: `note ${k}`, markdown: `first ${k}`, space_id: s.id, ...(parent ? { parent_id: parent.id } : {}) });
    if (res.status !== 201) fail(`create note: ${res.status} ${JSON.stringify(res.json)}`);
    m.notes.push({ id: res.json.id, space: s.id, parent: parent?.id ?? null, title: `note ${k}`, body: `first ${k}`, deleted: false, deletedBy: null, tagged: false });
  });

const setMember = (si: number, who: Member, perm: Perm | null) => command(
  `owner ${perm === null ? `removes ${who} from` : `sets ${who} to ${perm} in`} space ${si}`,
  (m) => m.spaces.length > 0 && (perm !== null || pick(m.spaces, si).members.has(who)),
  async (m, r) => {
    const s = pick(m.spaces, si);
    const res = perm === null
      ? await call(r, m, "owner", "DELETE", `/api/spaces/${s.id}/members/${r.ids[who]}`)
      : await call(r, m, "owner", "PUT", `/api/spaces/${s.id}/members/${r.ids[who]}`, { permission: perm });
    if (!is2xx(res.status)) fail(`set member: ${res.status} ${JSON.stringify(res.json)}`);
    if (perm === null) s.members.delete(who); else s.members.set(who, perm);
    // The very next reads already follow the change.
    await sweepReads(r, m, who === "G" ? (["tok0", "tok1"] as Who[]) : [who]);
  });

const toggleAi = (si: number, on: boolean) => command(`owner turns "AI can read" ${on ? "on" : "off"} in space ${si}`,
  (m) => m.spaces.length > 0, async (m, r) => {
    const s = pick(m.spaces, si);
    const res = await call(r, m, "owner", "PATCH", `/api/spaces/${s.id}`, { capabilities: { external_ai: on } });
    if (!is2xx(res.status)) fail(`toggle AI: ${res.status} ${JSON.stringify(res.json)}`);
    s.externalAi = on;
    await sweepReads(r, m, ["tok0", "tok1"]);
  });

const mintToken = (slot: 0 | 1, access: Access) => command(`owner mints token ${slot} (${access})`,
  (m) => m.tokens[slot] === null || m.tokens[slot]!.revoked, async (m, r) => {
    const res = await call(r, m, "owner", "POST", `/api/actors/${r.ids.G}/tokens`, { name: `props-${++m.counter}`, access });
    if (res.status !== 201) fail(`mint token: ${res.status} ${JSON.stringify(res.json)}`);
    m.tokens[slot] = { id: res.json.id, plaintext: res.json.token, access, revoked: false };
    await sweepReads(r, m, [slot === 0 ? "tok0" : "tok1"]);
  });

const revokeToken = (slot: 0 | 1) => command(`owner revokes token ${slot}`,
  (m) => m.tokens[slot] !== null && !m.tokens[slot]!.revoked, async (m, r) => {
    const t = m.tokens[slot]!;
    const res = await call(r, m, "owner", "POST", `/api/actors/${r.ids.G}/tokens/${t.id}/revoke`);
    if (!is2xx(res.status)) fail(`revoke token: ${res.status} ${JSON.stringify(res.json)}`);
    t.revoked = true;
    // Revoking blocks the token immediately, on reads and writes alike.
    const w: Who = slot === 0 ? "tok0" : "tok1";
    await sweepReads(r, m, [w]);
    const any = m.notes[0];
    if (any) await probeEdit(r, m, w, any, "title");
  });

const setTokenAccess = (slot: 0 | 1, access: Access) => command(`owner sets token ${slot} to ${access}`,
  (m) => m.tokens[slot] !== null && !m.tokens[slot]!.revoked, async (m, r) => {
    const t = m.tokens[slot]!;
    const res = await call(r, m, "owner", "PATCH", `/api/actors/${r.ids.G}/tokens/${t.id}`, { access });
    if (!is2xx(res.status)) fail(`set token access: ${res.status} ${JSON.stringify(res.json)}`);
    t.access = access;
    // The next write already follows the new access.
    const w: Who = slot === 0 ? "tok0" : "tok1";
    for (const n of m.notes.slice(0, 3)) await probeEdit(r, m, w, n, "title");
  });

// probes -------------------------------------------------------------------
const needsNote = (m: Model) => m.notes.length > 0;
const needsToken = (w: Who) => (m: Model) => !isTok(w) || tokenOf(m, w) !== null;

const read = (w: Who, ni: number) => command(`${w} reads note ${ni}`, (m) => needsNote(m) && needsToken(w)(m),
  (m, r) => probeRead(r, m, w, pick(m.notes, ni)));
const listings = (w: Who) => command(`${w} lists notes (bootstrap, sync, MCP)`, needsToken(w), (m, r) => probeListings(r, m, w));
const spacesList = (w: Who) => command(`${w} lists spaces`, needsToken(w), (m, r) => probeSpaces(r, m, w));
const edit = (w: Who, ni: number, what: "body" | "title") => command(`${w} edits the ${what} of note ${ni}`,
  (m) => needsNote(m) && needsToken(w)(m), (m, r) => probeEdit(r, m, w, pick(m.notes, ni), what));
const tag = (w: Who, ni: number) => command(`${w} toggles the tag on note ${ni}`,
  (m) => needsNote(m) && needsToken(w)(m), (m, r) => probeTag(r, m, w, pick(m.notes, ni)));
const del = (w: Who, ni: number) => command(`${w} deletes note ${ni}`,
  (m) => needsNote(m) && needsToken(w)(m), async (m, r) => {
    await probeDelete(r, m, w, pick(m.notes, ni));
    await sweepReads(r, m, everyone(m));
  });
const undelete = (w: Who, ni: number) => command(`${w} restores deleted note ${ni}`,
  (m) => needsToken(w)(m) && m.notes.some((n) => n.deletedBy === n.id && (n.parent === null || !m.notes.find((p) => p.id === n.parent)!.deleted)),
  async (m, r) => {
    const cands = m.notes.filter((n) => n.deletedBy === n.id && (n.parent === null || !m.notes.find((p) => p.id === n.parent)!.deleted));
    await probeUndelete(r, m, w, pick(cands, ni));
    await sweepReads(r, m, everyone(m));
  });
const move = (w: Who, ni: number, si: number) => command(`${w} moves note ${ni} to another space`,
  (m) => needsNote(m) && m.spaces.length > 1 && needsToken(w)(m), async (m, r) => {
    const n = pick(m.notes, ni);
    const others = m.spaces.filter((s) => s.id !== n.space);
    const to = pick(others, si);
    // A token may not use REST: its attempt is refused whatever the target.
    await probeMove(r, m, w, n, to);
    await sweepReads(r, m, everyone(m));
  });
const manage = (w: Exclude<Who, "owner">, si: number, kind: "join" | "ai" | "rename") => command(`${w} tries to manage space ${si} (${kind})`,
  (m) => m.spaces.length > 0 && needsToken(w)(m), (m, r) => probeManage(r, m, w, pick(m.spaces, si), kind));

// generators ---------------------------------------------------------------
const idx = fc.nat(9);
const whoArb = fc.constantFrom(...WHO);
const nonOwner = fc.constantFrom<Exclude<Who, "owner">>("A", "B", "tok0", "tok1");
const memberArb = fc.constantFrom<Member>("A", "B", "G");
const slotArb = fc.constantFrom<0 | 1>(0, 1);
const accessArb = fc.constantFrom<Access>("read", "write");

const commandArb = fc.oneof(...[
  { w: 3, a: fc.constant(null).map(createSpace) },
  { w: 4, a: fc.tuple(idx, fc.boolean(), idx).map(([s, p, i]) => createNote(s, p, i)) },
  { w: 6, a: fc.tuple(idx, memberArb, fc.constantFrom<Perm | null>("view", "edit", "view", "edit", null)).map(([s, m, p]) => setMember(s, m, p)) },
  { w: 3, a: fc.tuple(idx, fc.boolean()).map(([s, on]) => toggleAi(s, on)) },
  { w: 3, a: fc.tuple(slotArb, accessArb).map(([s, a]) => mintToken(s, a)) },
  { w: 2, a: slotArb.map(revokeToken) },
  { w: 3, a: fc.tuple(slotArb, accessArb).map(([s, a]) => setTokenAccess(s, a)) },
  { w: 6, a: fc.tuple(whoArb, idx).map(([w, i]) => read(w, i)) },
  { w: 4, a: whoArb.map(listings) },
  { w: 3, a: whoArb.map(spacesList) },
  { w: 6, a: fc.tuple(whoArb, idx, fc.constantFrom<"body" | "title">("body", "title")).map(([w, i, k]) => edit(w, i, k)) },
  { w: 3, a: fc.tuple(whoArb, idx).map(([w, i]) => tag(w, i)) },
  { w: 3, a: fc.tuple(whoArb, idx, idx).map(([w, i, s]) => move(w, i, s)) },
  { w: 3, a: fc.tuple(whoArb, idx).map(([w, i]) => del(w, i)) },
  { w: 3, a: fc.tuple(whoArb, idx).map(([w, i]) => undelete(w, i)) },
  { w: 2, a: fc.tuple(nonOwner, idx, fc.constantFrom<"join" | "ai" | "rename">("join", "ai", "rename")).map(([w, s, k]) => manage(w, s, k)) },
].map(({ w, a }) => ({ weight: w, arbitrary: a as fc.Arbitrary<Cmd> })));

// ── The world of one run ────────────────────────────────────────────────────
let ws = "";
async function freshWorld(): Promise<{ model: Model; real: Real }> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const human = async (label: string) => {
    const external = `props-${label}-${stamp}`;
    const id = (await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type, external_id) VALUES ($1, $2, 'human', $3) RETURNING id::text`,
      [ws, `Props ${label} ${stamp}`, external])).rows[0]!.id;
    return { id, external };
  };
  const owner = await human("owner"), a = await human("A"), b = await human("B");
  const agent = (await q<{ id: string }>(
    `INSERT INTO actors (workspace_id, name, type, external_id) VALUES ($1, $2, 'agent', $3) RETURNING id::text`,
    [ws, `Props agent ${stamp}`, `props-agent-${stamp}`])).rows[0]!.id;
  await setWorkspaceOwner(ws, owner.id);
  const ids = { owner: owner.id, A: a.id, B: b.id, G: agent };
  currentIds = ids;
  const model = newModel();
  const real: Real = {
    ws, ext: { owner: owner.external, A: a.external, B: b.external }, ids, tagId: "",
    baseline: Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id), 0)::text AS m FROM domain_events WHERE workspace_id = $1`, [ws])).rows[0]!.m),
  };
  const tag = await call(real, model, "owner", "POST", "/api/tags", { name: `props tag ${stamp}` });
  if (tag.status !== 201) throw new Error(`world: cannot create the tag: ${tag.status} ${JSON.stringify(tag.json)}`);
  real.tagId = tag.json.id;
  // A starting position, so short sequences already have something to probe:
  // two spaces, A (view) and the agent (edit) in the first, B (edit) in the
  // second, three notes (one under another), and a write token.
  await createSpace().run(model, real);
  await createSpace().run(model, real);
  await setMember(0, "A", "view").run(model, real);
  await setMember(0, "G", "edit").run(model, real);
  await setMember(1, "B", "edit").run(model, real);
  await toggleAi(0, true).run(model, real);
  await createNote(0, false, 0).run(model, real);
  await createNote(0, true, 0).run(model, real);
  await createNote(1, false, 0).run(model, real);
  await mintToken(0, "write").run(model, real);
  return { model, real };
}

/** The property: any sequence of commands keeps every outcome equal to the model's. */
const permissionProperty = () => fc.asyncProperty(
  fc.commands([commandArb], { maxCommands: 30, size: "max" }),
  async (cmds) => { await fc.asyncModelRun(freshWorld, cmds); },
);

// A larger run keeps the default small: PROPS_RUNS=60 for a bigger one.
const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 12;

describe.skipIf(!isTestDatabase())("permission state changes over time (model-based, real routes + MCP gate)", () => {
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    ws = await getWorkspaceId();
    console.log(`[permissions.property] PROPS_SEED=${PROPS_SEED} (replay with PROPS_SEED=${PROPS_SEED} PROPS_RUNS=<n>)`);
  });

  it("every probe follows the model while permissions change", async () => {
    await checkAsync(permissionProperty(), RUN_CAP);
    console.log(`[permissions.property] write probes checked: ${tally.allowed} allowed, ${tally.refused} refused, ${tally.revoked} by a revoked token`);
  }, 600_000);

  // Sanity: the model and the real app agree on a hand-written sequence with a
  // change in the middle, so the property cannot pass by every command no-opping.
  it("sanity: a member's edit right ends with the very next request after the owner downgrades them", async () => {
    const { model: m, real: r } = await freshWorld();
    await createSpace().run(m, r);
    await createNote(0, false, 0).run(m, r);
    await setMember(0, "A", "edit").run(m, r);
    await edit("A", 0, "body").run(m, r);
    expect(m.notes[0]!.body).toMatch(/^body /);
    await setMember(0, "A", "view").run(m, r);
    await edit("A", 0, "body").run(m, r); // predicted refused, and refused
    await setMember(0, "A", null).run(m, r);
    await read("A", 0).run(m, r); // predicted 404, and 404
    expect(visibleIds(m, "A")).toEqual([]);
  });
});
