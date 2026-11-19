// Spine — authority layer.
//
// One place that answers "is this actor allowed to perform this mutation?".
// A mutation declares the Authority it needs; mutate() calls assertAuthority()
// before it will run apply(), so there is no "forgot to check" path.
//
// Notes are governed by SPACES (docs/architecture/spaces.md): reading needs
// membership in the note's space, writing needs the `edit` permission there; a
// token is further limited to spaces that let external AI in, and to reading
// when its access is `read`. Tags carry no permission: anyone may apply a tag to a note
// they can write, but a tag DEFINITION (title, page, schema, views, deletion)
// is global and only the workspace owner changes it. Workspace administration
// (members, tokens, modules, settings) is the owner's too (isWorkspaceOwner).

import type { ActorCtx } from "../types.js";
import { isUuid } from "@onden/markdown";
import { q } from "../db.js";
import { isWorkspaceConfigNode, isWorkspaceConfigTag } from "./reservedNodes.js";
import { canWriteSomewhere, isTagDefinition, spaceCanRead, spaceCanWrite, spaceWritable } from "./spaceScope.js";
import { spaceAccess, workspaceOwnerSql } from "./spaceAccess.js";
import { AuthorityError } from "./authorityError.js";
import { replicatedAuthor } from "./replicatedOp.js";
export { AuthorityError };
import { assertSystemAuthority, systemJobOf } from "./systemJobs.js";

/** What a node authority asks for. `read` needs membership of the note's
 *  space; every other op needs the `edit` permission there. Workspace-level
 *  administration is the owner's (isWorkspaceOwner). */
export type Operation =
  | "apply"
  | "remove"
  | "set_attribute"
  | "delete_attribute"
  | "read"
  | "write_node"
  | "delete_node";

// What a mutation is allowed to require. A discriminated union so every call
// site states its intent explicitly. `open` is the only unrestricted form and
// it carries a `why` so unguarded mutations stay greppable and auditable —
// "no check" is a deliberate, visible choice, never a silent omission.
export type Authority =
  | { kind: "node"; nodeId: string; op: Operation }
  // Explicit history/restore authority: a retained row may be live or trashed,
  // but must still exist. Its full retained ancestor chain and BOTH tag scopes
  // remain authoritative. Ordinary node access must use `node` (live-only).
  | { kind: "retained_node"; nodeId: string; op: Operation }
  | { kind: "tag"; tagId: string; op: Operation }
  // Changing membership needs both sides: the current target must be readable
  // and writable, and the tag must permit apply/remove. Human scope never
  // relaxes. Applying may enroll an otherwise untagged ordinary node into a
  // token's scope; task-local tags cannot enroll its host on the token's behalf.
  | { kind: "tag_membership"; nodeId: string; tagId: string; op: "apply" | "remove" }
  // The actor may write in at least one space (spaceScope.ts
  // canWriteSomewhere): every person, and a write token whose agent edits one. The gate for creating content before its space is known — the
  // create path then checks the space it lands in (newNoteSpace,
  // canPlaceUnder) — and for creating a tag. It grants nothing on any
  // particular note, tag definition or workspace setting.
  | { kind: "any_space_write" }
  // Deciding agent changes in the inbox (reviewAuthority): the owner. Never a
  // delegated token. Not a space permission.
  | { kind: "review" }
  // What the actor may do in a SPACE (spine/spaceAccess.ts): `read` =
  // member, `write` = `edit` permission, `manage` = the workspace owner on a
  // SHARED space, or a person on their own personal space; managing covers
  // the other two. A delegated token never holds space authority
  // here: agents only propose space moves and membership changes.
  | { kind: "space"; spaceId: string; need: "read" | "write" | "manage" }
  // Creating content directly in a space: the `edit` permission there; a
  // token also needs access `write` and the space's external_ai on.
  | { kind: "space_write"; spaceId: string }
  // The workspace OWNER (isWorkspaceOwner): permission-defining and
  // workspace-wide operations — members, tokens, tag definitions, modules,
  // workspace settings. The rule "the human is prioritized over the agent" is
  // realized here: a delegated bearer token NEVER qualifies, even one carrying
  // the admin role, because an agent that could mint tokens or rewrite tag
  // definitions could escalate past whoever granted it. The signal is
  // `tokenScope` (set iff the actor resolved from a bearer token), NOT
  // actor.type — the native-app owner resolves to a type='agent' System actor.
  | { kind: "principal_admin" }
  // A write INSIDE an already-authorized cascade (a template expansion, a
  // schema default seeding). The cascade ROOT was gated once — runCascade()
  // asserted the real authority ({node, write_node}) against the root actor, or
  // a root mutate's own authority did — and the child inherits it. assertAuthority
  // therefore SKIPS the re-check (re-checking would change semantics: it could
  // re-deny a legitimately-rooted cascade, and it would double the cost). This
  // is NOT a bypass hole: mutate() guarantees BY CONSTRUCTION that `cascade`
  // authority is only reachable inside a parent cascade store — it throws if
  // used as a root — so the only way to reach this skip is through a path that
  // already passed runCascade()'s gate. The asymmetry the spine kills: cascade
  // authority used to be enforced by-discipline (each dispatcher remembered to
  // call cascadeAllowed); now it's by-construction.
  | { kind: "cascade" }
  // The actor's OWN personal data or settings (mutatePersonal): a person's own rows, never a temporary session's: a session reads
  // its person's personal rows but never writes them back (it runs on a computer that is not theirs).
  | { kind: "own_personal" }
  // A background job's own write (spine/systemJobs.ts): valid only for a system
  // actor, whose declaration (event kinds, targets, module) mutate() checks per
  // event. The only authority a system actor holds besides `cascade`.
  | { kind: "system" }
  // A write that cannot be undone (assertUndoableBy): refused to a temporary session; anyone else needs `of`.
  | { kind: "irreversible"; of: Authority }
  | { kind: "open"; why: string };

/** Is `actor` the workspace owner (workspaces.owner_actor_id)? The owner is the
 *  one principal of docs/architecture/spaces.md: the `principal_admin`
 *  authority, the reviewer, and the only one who may step into any shared
 *  space. Acts through a session or the native app — the native app's System
 *  actor (external_id 'system'; the native bypass is off in production) is the
 *  owner on that device — never through a delegated token. A workspace with no
 *  owner has none (the first person to sign in becomes it): nobody inherits it.
 *  Reads the current rows, so an ActorCtx resolved earlier cannot keep owner
 *  rights; also usable by routes that must refuse before any lookup (a 404/403
 *  difference must not probe rows). */
export async function isWorkspaceOwner(actor: ActorCtx): Promise<boolean> {
  if (actor.tokenScope) return false;
  const r = await q(
    `SELECT 1 FROM actors a JOIN workspaces w ON w.id = a.workspace_id
      WHERE a.id::text = $1 AND ${workspaceOwnerSql("a", "w")}`,
    [actor.id],
  );
  return r.rows.length > 0;
}

/** A person (a signed-in human or the native app), not a delegated token and not a temporary session: a session is a person's hands on
 *  a computer that is not theirs, and what needs the person themselves (backups, the whole export, opening sessions, starting an AI,
 *  proving who they are again) is not for it. */
export function isPerson(actor: ActorCtx): boolean {
  return !actor.tokenScope && !isTemporarySessionActor(actor);
}

/** The write is a person's: a human acting for themselves, or their temporary session (their own typing on another computer, so it resolves a conflict
 *  in a space it may write in). A system job, an AI agent and any delegated token are not: only a person's write resolves a conflict (migration 206).
 *  What an AI proposed and a person accepted is the person's write. */
export function writesAsPerson(actor: ActorCtx): boolean {
  return (actor.type === "human" && !actor.tokenScope) || isTemporarySessionActor(actor);
}

/** Whose personal rows (preferences, review settings and progress, focus records, RSS seen and mutes, external calendars) does `actor` READ?
 *  Their own; a temporary session's are the ones of the person who opened it ("reads yours, never writes back": the person is on a computer that is
 *  not theirs and wants their own settings and progress there). The one answer for every personal read; writes never use it: they run in
 *  mutatePersonal, which refuses a session (`own_personal`) and keys the row by the writer's own id. `openedBy` is re-read from
 *  participant_sessions at every request (spine/currentActor.ts), never taken from the client.
 *  What a session may SEE of those rows is narrower than what the person sees: each read point hides what a session has no use for
 *  (docs/architecture/proposals/sessions-reads-own-2026-11-17.md). */
export function personalDataOwnerId(actor: ActorCtx): string {
  if (!isTemporarySessionActor(actor)) return actor.id;
  if (!actor.sessionScope) throw new AuthorityError("session", "a temporary session without its scope reads nothing"); // fail closed: resolveCurrentActor always sets it
  return actor.sessionScope.openedBy;
}

/** The id a CARRIED "who did this" column records for a write by `actor` (function_refs.created_by, ai_edit_suggestion_items.decided_by,
 *  rss_subscriptions.created_by_actor_id: columns of rows that travel to the person's other nodes, spine/snapshotTables.json): the writer's id when it
 *  is a person or an AI, whose `actors` rows travel too; null for a temporary session, whose id must not leave this node (its row never does:
 *  `neverLeaves`), and for an operator with no uuid (the System account, a console), as before. Never the person who opened the session: that would
 *  credit them with what the session did. Who wrote it stays where it is local: the event (domain_events.actor_id) and the stamp's author.
 *  The function that writes such a column calls this itself; carriedActorColumns.integration.test.ts lists every such column of every carried table. */
export function carriedActorId(actor: ActorCtx): string | null {
  return isTemporarySessionActor(actor) || !isUuid(actor.id) ? null : actor.id;
}

/** The device a write by `actor` records (domain_events.device_id, a stamp's `device`, a block anchor event's `device`): the one the client
 *  says it is (X-Onden-Device-Id, an editor save's `body_change.device`) for a person or an AI; null for a temporary session. A session runs on a
 *  computer that is not trusted: what it calls its device is whatever it chose (another node's id, its browser's install id), and a stamp's device
 *  travels with the stamp to the person's other nodes. Null, as for background work, rather than a value this server makes up for the session:
 *  anything derived from the session would put something of it in what leaves this node. */
export function recordedDeviceId(actor: ActorCtx | null | undefined, supplied: string | null | undefined): string | null {
  return actor && isTemporarySessionActor(actor) ? null : supplied ?? null;
}

/** A temporary session never does what cannot be undone. It runs on a computer that is not trusted: what it changes, or throws in the trash, can be
 *  brought back (restoreEvent, the trash); a purge, the emptying of a trash, or the deletion of something no restore brings back (the event types
 *  restoreContract.ts restoreBlockedReason calls "irreversible" or "unsupported": a saved view, a link, a pointer; a cleared AI conversation) cannot.
 *  The class, each member and why: docs/architecture/proposals/sessions-reads-own-2026-11-17.md §2d. An operation in the class declares it: its authority
 *  is `{ kind: "irreversible", of }` (mutate, assertAuthority), or, where nothing else is asserted first, it calls this at its entry. */
export function assertUndoableBy(actor: ActorCtx): void {
  if (isTemporarySessionActor(actor)) throw new AuthorityError("session_irreversible", IRREVERSIBLE_REFUSAL);
}
/** A temporary session never makes this server fetch from the network (a feed, a page, an article): the computer it runs on is not trusted,
 *  and what it asks for would be fetched from the server's own address, its answer written into notes that travel. Called by every request that
 *  reaches out, BEFORE the fetch (each one also checks its ordinary authority before fetching); the list and the test are
 *  sessionNoOutboundFetch.integration.test.ts. Background work (the outbox) fetches only what a person set up. */
export function assertMayReachOut(actor: ActorCtx): void {
  if (isTemporarySessionActor(actor)) throw new AuthorityError("session", "a temporary session does not make this server fetch from the network");
}

/** A temporary session never changes who can read a note or whether it can reach the website: moving an existing note to another space (it then
 *  has the target space's readers, and a published space puts it on the site at the next publish; leaving one takes the page down at once), or
 *  turning a hidden note into an ordinary one (it becomes a page of a published space at the next publish). Those are a person's (PR #1856 review
 *  round 5: the owner's decision). Moving and ordering inside one space stay a write. Called by the one authorization of a space move
 *  (services/spaces.ts sourceAuthority: the move route, the restore of NODE_MOVED_SPACE, a task's placement into a note of another space) and
 *  by the promote of a hidden note. */
export function assertKeepsReaders(actor: ActorCtx): void {
  if (isTemporarySessionActor(actor)) throw new AuthorityError("session", "a temporary session does not change who can read a note or what reaches the website");
}

/** The refusal's text: the app's routes answer an authority refusal with its message (httpError.ts), as `own_personal`'s; the AI tool surface with the reason. */
const IRREVERSIBLE_REFUSAL = "a temporary session cannot do what cannot be undone";

/** Is `actor` a temporary session? THE one question: the refusal to write a person's data, the choice of whose rows to read and what a session is not given all ask it, so they
 *  cannot disagree. A session is a type 'session' actor with a `sessionScope`; `ActorCtx` is built with one only in spine/currentActor.ts (readGuard.test.ts). */
export function isTemporarySessionActor(actor: ActorCtx): boolean {
  return isSessionActorType(actor.type);
}

/** The same question of an `actors.type` value read from a row (an author joined in a history read, the actor removeActor is asked to remove). */
export function isSessionActorType(type: string | null | undefined): boolean {
  return type === "session";
}

/** Operations only a person may do (backups, creating spaces, ...): a delegated
 *  token or a temporary session is refused with one answer — 403, `{ error: <message> }` through
 *  AuthorityError — whichever operation it tried. `capability` names it in
 *  AuthorityError.reason. Call before any lookup, so a token learns nothing. */
export function requirePerson(actor: ActorCtx, capability: string): void {
  if (!isPerson(actor)) throw new AuthorityError(capability, "this is reserved to a person; a delegated token or a temporary session cannot do it");
}

/** May `actor` approve or reject agent changes in the inbox — the one rule
 *  for "who reviews" (routes/inbox.ts, services/eventReview.ts and the
 *  bootstrap's `can_review` all ask here): the workspace owner. A delegated
 *  token never reviews: an agent approving its own kind's changes defeats the
 *  review. */
export async function reviewAuthority(actor: ActorCtx): Promise<boolean> {
  return isWorkspaceOwner(actor);
}

// The workspace-config tag and the Site Config node hold the workspace
// settings, so any change to them needs the same authority as PATCH
// /api/workspace/config, and neither may be deleted: the settings would be
// recreated empty and bootstrap would fail on the leftover slug. Reads stay
// governed by the ordinary read policy. See spine/reservedNodes.ts (GAP-260).
async function assertOwnerForConfig(actor: ActorCtx, what: string, op: Operation): Promise<void> {
  if (op === "delete_node") {
    throw new AuthorityError("reserved", `${what} holds the workspace settings and cannot be deleted`);
  }
  if (!(await isWorkspaceOwner(actor))) {
    throw new AuthorityError("reserved", `${what} holds the workspace settings; changing it requires the workspace owner`);
  }
}


/** The owner-only part of assertAuthority, kept for a replayed op: the config node and the config tag. */
async function assertReplicatedConfig(actor: ActorCtx, a: Authority): Promise<void> {
  if (a.kind === "irreversible") return assertReplicatedConfig(actor, a.of); // a replicated author is never a temporary session
  if ((a.kind === "node" || a.kind === "retained_node") && a.op !== "read" && await isWorkspaceConfigNode(a.nodeId)) {
    await assertOwnerForConfig(actor, `node ${a.nodeId}`, a.op);
  }
  if (a.kind === "tag_membership") {
    if (await isWorkspaceConfigNode(a.nodeId)) await assertOwnerForConfig(actor, `node ${a.nodeId}`, "write_node");
    if (await isWorkspaceConfigTag(a.tagId)) await assertOwnerForConfig(actor, `tag ${a.tagId}`, a.op);
  }
  if (a.kind === "tag" && a.op !== "read" && await isWorkspaceConfigTag(a.tagId)) {
    await assertOwnerForConfig(actor, `tag ${a.tagId}`, a.op);
  }
}

export async function assertAuthority(actor: ActorCtx, a: Authority): Promise<void> {
  // Replaying a replicated op the sync engine already validated (spine/replicatedOp.ts): its author passes the space and node
  // checks, but not the workspace-settings rule, which the engine does not model: a remote editor must not reach the settings.
  if (replicatedAuthor(actor)) return assertReplicatedConfig(actor, a);
  // A system actor has no row in `actors`, no role and no owner shortcut: it
  // holds `system`/`cascade` and nothing else, whatever authority a caller asks.
  if (systemJobOf(actor) || a.kind === "system") {
    assertSystemAuthority(actor, a.kind);
    return;
  }
  switch (a.kind) {
    case "open":
      return;

    case "own_personal":
      if (isTemporarySessionActor(actor)) throw new AuthorityError("session", "a temporary session never writes its person's personal data");
      return;

    case "irreversible":
      assertUndoableBy(actor);
      return assertAuthority(actor, a.of);

    case "cascade":
      // Already gated at the cascade root (see the Authority union note). The
      // confinement that makes this safe lives in mutate(), not here: a `cascade`
      // authority with no enclosing cascade store throws before reaching apply().
      return;

    case "any_space_write":
      if (!(await canWriteSomewhere(actor))) throw new AuthorityError("space", "no space this actor may write");
      return;

    case "review":
      if (!(await reviewAuthority(actor))) {
        throw new AuthorityError("role", "reviewing agent changes needs the workspace owner");
      }
      return;

    case "space": {
      if (actor.tokenScope) {
        throw new AuthorityError("space", "a delegated token cannot act on spaces directly; propose the change instead");
      }
      const access = await spaceAccess(actor, a.spaceId);
      // A space the actor cannot even read answers as a space that is not there: one answer, so the id of a space they are not in cannot be told apart from an unused one.
      if (!access || (!access.read && !access.manage)) throw new AuthorityError("space", "space not found");
      if (access.manage || access[a.need]) return; // managing covers every level (the owner intervenes)
      throw new AuthorityError("space", `space access is below required '${a.need}'`);
    }

    case "space_write":
      if (!(await spaceWritable(actor, a.spaceId))) {
        throw new AuthorityError("space", `cannot write into space ${a.spaceId}`);
      }
      return;

    case "principal_admin":
      // A delegated token may not redefine permissions — full stop, regardless
      // of role. This is the structural "agent cannot rewrite the rules".
      if (actor.tokenScope) {
        throw new AuthorityError("principal", "permission administration is reserved to the workspace owner; a delegated token cannot redefine permissions");
      }
      if (!(await isWorkspaceOwner(actor))) {
        throw new AuthorityError("owner", "this is reserved to the workspace owner");
      }
      return;

    case "node":
    case "retained_node": {
      if (a.op !== "read" && await isWorkspaceConfigNode(a.nodeId)) {
        await assertOwnerForConfig(actor, `node ${a.nodeId}`, a.op);
      }
      const lifecycle = a.kind === "retained_node" ? "retained" : "live";
      if (a.op === "read") {
        if (!(await spaceCanRead(actor, a.nodeId, lifecycle))) throw new AuthorityError("space", "space role denied 'read' on this note");
        return;
      }
      if (await spaceCanWrite(actor, a.nodeId, lifecycle)) return;
      // A tag definition is in no space: renaming, moving, deleting it or
      // nesting content under it is the owner's (it reaches every member).
      if (await isTagDefinition(a.nodeId) && await isWorkspaceOwner(actor)) return;
      throw new AuthorityError("space", `space role denied '${a.op}' on this note`);
    }

    case "tag_membership": {
      if (await isWorkspaceConfigNode(a.nodeId)) await assertOwnerForConfig(actor, `node ${a.nodeId}`, "write_node");
      // A tag carries no permission: tagging a note is editing it.
      if (!(await spaceCanWrite(actor, a.nodeId, "live"))) {
        throw new AuthorityError("space", "space role denied tagging this note");
      }
      await assertAuthority(actor, { kind: "tag", tagId: a.tagId, op: a.op });
      return;
    }

    case "tag": {
      if (a.op !== "read" && await isWorkspaceConfigTag(a.tagId)) {
        await assertOwnerForConfig(actor, `tag ${a.tagId}`, a.op);
      }
      // Reading, applying or removing a tag needs only a live definition the
      // actor can see (tag_membership checks write on the note itself);
      // changing the definition is the owner's.
      if (a.op === "read" || a.op === "apply" || a.op === "remove") {
        if (!(await spaceCanRead(actor, a.tagId, "live"))) throw new AuthorityError("space", `tag ${a.tagId} is not readable`);
        return;
      }
      if (!(await isWorkspaceOwner(actor))) throw new AuthorityError("owner", `changing tag ${a.tagId} is reserved to the workspace owner`);
      return;
    }
  }
}
