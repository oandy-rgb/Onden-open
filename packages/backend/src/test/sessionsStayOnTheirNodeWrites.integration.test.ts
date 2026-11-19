// What a temporary session WRITES does not carry its id off the node (extends sessionsStayOnTheirNode.integration.test.ts, which follows one note
// across two nodes; docs/architecture/proposals/sessions-reads-own-2026-11-17.md §2b, §2c).
//
// The session does every write the product lets it try: the write-route inventory of the sweep (helpers/sweepWriteBodies.ts: one valid request per
// mounted write route, complete or crossWorkspaceWriteSweep fails), each aimed at fresh objects of its own workspace (helpers/sweepWriteWorld.ts, as the
// sweep's positive pass does, so one route using an object up does not starve the next), as a request with the session's credential through the
// assembled app, with ANOTHER device's id in X-Onden-Device-Id. Judged route by route (PR #1856 rounds 4–5), from the answers:
//   - refused: every answer 401/403, AND the refusal that made the answer is a session's rule (the one the error handler mapped, recorded in
//     apiOnError; requirePerson's message; the answer codes of the person- and owner-only routes), not a permission it lacks in this world — where
//     the sweep's request is refused by the world, the session gets one it may make (SESSION_REQUESTS); refusals a session can never get past but
//     that name no session rule are listed with why (STRUCTURAL_REFUSALS);
//   - succeeded: every answer 2xx, listed in SESSION_ROUTES with why and the effect it must leave (an event, its own upload, an answer to read);
//   - neither (404/400/409/422): listed in NEITHER with why the walk cannot make it work.
// What a successful request took away is judged by its effect: its stamps' tombstones and overwrites, and the rows gone or changed in the tables with
// no stamps (UNSTAMPED_TABLES); each needs a restorable root event of that request (RELYING_ON_ROOT names the ones that rely on it), unless it is a
// name or an arrangement. A route with no request, or one that timed out, fails the test.
//
// Then the owner reads what would leave the node, a snapshot (its pages and its digest) and a change bundle, as the JSON that goes on the wire: the
// session's actor id, its participant_sessions id, its credential and the credential's hash appear nowhere, except the actor id as the `author` of a
// STAMP (that is who wrote; spine/stampedMerge/unit.ts) — taken out by the stamp's shape, not by the key's name. The device the session named is
// recorded nowhere (spine/authority.ts recordedDeviceId). The carried columns that hold an actor id record null for a session (carriedActorId; the
// column list is carriedActorColumns.integration.test.ts).
//
// Never printed: the credential (assertions say only whether it was found).
// SAFETY: only runs against a *_test database; skips otherwise. One world for the file (the walk is one beforeAll).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { freshWorkspace } from "./helpers/roundTripWorld.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { workspaceSwitch } from "./helpers/workspaceSwitch.js";
import { mountedRoutes } from "./helpers/appRoutes.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { SWEEP_SECRET_KEY, buildSweepObjects, fieldsUsed, type SweepObjects, type SweepSide } from "./helpers/sweepWriteWorld.js";
import { startFakeMessagesService } from "./helpers/fakeMessagesService.js";
import { WRITE_CONTENT, type SweepRequest } from "./helpers/sweepWriteBodies.js";
import { ticketWithoutEvidence } from "./helpers/freshProofTicket.js";
import { openTemporarySession, resolveTemporarySessionActor } from "../services/participantSessions.js";
import { readStampedPages } from "../services/stampedSnapshot.js";
import { readChangeBundle } from "../services/stampedBundle.js";
import { spaceAccess } from "../spine/spaceAccess.js";
import { createNote } from "../services/noteCreate.js";
import { updateNode } from "../services/nodeUpdate.js";
import { restoreBlockedReason } from "../services/restoreContract.js";
import { sha256Hex } from "../utils.js";
import { makeSpace } from "./helpers/spaceFixtures.js";

const raised = vi.hoisted(() => ({ answered: null as null | { reason: string; message: string } }));
/** The reason of the refusal that made the last answer (read through a function: a reset just before narrows the field for the type checker). */
const answeredReasons = (): string[] => (raised.answered ? [raised.answered.reason] : []);
/** The refusal that MADE the answer (rounds 6–7, point 5): the error the app's error handler (httpError.ts apiOnError, mounted by app.ts) turned
 *  into the response, recorded there and nowhere else: not a refusal built and caught on the way, and not spineErrorStatus itself, which
 *  services/eventReview.ts also asks for each event of a batch. */
vi.mock("../httpError.js", async (original) => {
  const real = await original<typeof import("../httpError.js")>();
  return { ...real, apiOnError: (error: Error, c: Parameters<typeof real.apiOnError>[1]) => {
    if (error && typeof error === "object" && "reason" in error) raised.answered = { reason: String((error as { reason: unknown }).reason), message: String(error.message ?? "") };
    return real.apiOnError(error, c);
  } };
});

registerShippedModules();

// Nobody signs in, except for the owner's one control save (signedIn.as): every other request carries the session's credential.
const signedIn = vi.hoisted(() => ({ as: "" }));
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => (signedIn.as ? { user: { id: signedIn.as, name: "Owner", email: `${signedIn.as}@sweep.test` } } : null)) },
    $context: Promise.resolve({ runMigrations: async () => {}, internalAdapter: { findAccounts: async () => [], deleteUserSessions: async () => undefined } }),
  },
  configuredSocialProviders: [],
}));
vi.mock("../db.js", async (original) => {
  const { workspaceSwitch } = await import("./helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});
vi.mock("../services/workspaceId.js", async (original) => {
  const { workspaceSwitch } = await import("./helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../services/workspaceId.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});

const { app } = await import("../app.js");
const keyOf = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
const asList = <T,>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

function fillPath(route: string, params: Record<string, string> = {}): string {
  return route.replace(/:([A-Za-z_]+)(?:\{[^}]*\})?/g, (_m, name: string) => encodeURIComponent(params[name] ?? randomUUID()));
}


/** A stamp, by its shape (spine/stampedMerge/unit.ts Stamp; a snapshot's stamp lines carry the same keys and more): the one object whose `author`
 *  is the writer. A row's own values are never this shape, so a column that happens to be called `author` stays in. */
const isStamp = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && ["origin", "seq", "wall", "counter", "author", "device"].every((k) => k in v);

/** The JSON that would go on the wire, with the `author` of each stamp taken out (the one place the session's id belongs). */
const withoutStampAuthors = (value: unknown) => JSON.stringify(value, function (this: unknown, key, v) { return key === "author" && isStamp(this) ? undefined : v; });

type Effect = "event" | "media row" | "answer" | `none here: ${string}`;
/** Every write route a temporary session gets a 2xx from, why it may, and what it must leave behind: "event" (an event of the session), "media row"
 *  (its upload), "answer" (a read sent as a POST: a body to read), or "none here: …" (the walk's request has nothing to do, said why; asserted to
 *  write nothing, so the line changes when it does). What it may not do: §2d of the proposal; what it removes or overwrites is judged below by effect. */
const SESSION_ROUTES: Record<string, { why: string; effect: Effect }> = {
  "DELETE /api/canvases/:id": { why: "a whiteboard into the trash (comes back from it)", effect: "event" },
  "DELETE /api/nodes/:id": { why: "a note into the trash (comes back from it)", effect: "event" },
  "DELETE /api/nodes/:id/attributes/:key": { why: "a field removed (ATTRIBUTE_DELETED is undoable)", effect: "event" },
  "DELETE /api/nodes/:id/tags/:tagId": { why: "a tag taken off (TAG_REMOVED is undoable)", effect: "event" },
  "DELETE /api/review/cards/:nodeId": { why: "a note no longer a card (FUNCTION_REF_REMOVED is undoable)", effect: "none here: the walk's note has no card to take off (changed: false)" },
  "PATCH /api/boards/:id": { why: "placing and moving cards on a board (taking one off is refused: no inverse)", effect: "event" },
  "PATCH /api/canvases/:id": { why: "a whiteboard renamed (a name; the person can rename it back)", effect: "event" },
  "PATCH /api/nodes/:id": { why: "a note edited (NODE_UPDATED is undoable)", effect: "event" },
  "PATCH /api/nodes/:id/views/:viewId": { why: "a view renamed or moved in the list (changing its settings is refused: no inverse)", effect: "event" },
  "PATCH /api/tasks/:id": { why: "a task's fields (ATTRIBUTE_SET is undoable)", effect: "event" },
  "POST /api/capture/inbox": { why: "quick capture: a note and its inbox tag", effect: "event" },
  "POST /api/edges": { why: "a link between notes it may edit (deleting one is refused)", effect: "event" },
  "POST /api/events/:event_id/restore": { why: "restoring an event: a new write under its own authority, undoable again (the publish mark is a person's)", effect: "event" },
  "POST /api/events/:event_id/revert-conflict": { why: "taking back one side of a conflict on a note it may edit", effect: "event" },
  "POST /api/history/agent-runs/:runId/redo": { why: "redoing an AI's run it undid", effect: "none here: the walk's run was not undone first (skipped)" },
  "POST /api/history/agent-runs/:runId/undo": { why: "undoing an AI's run on notes it may edit", effect: "event" },
  "POST /api/history/rewind": { why: "going back to an earlier time, note by note (each step undoable; undone by rewinds/:id/undo)", effect: "event" },
  "POST /api/history/rewinds/:rewindId/undo": { why: "undoing a rewind", effect: "event" },
  "POST /api/import/obsidian": { why: "importing Markdown files as notes", effect: "none here: the import's folder is not one the session may write (conflict folder_unavailable)" },
  "POST /api/media": { why: "an upload gets a new file name; nothing is overwritten", effect: "media row" },
  "POST /api/nodes": { why: "a new note in a space it may write", effect: "event" },
  "POST /api/nodes/:id/block-anchors/:anchorId/confirm": { why: "confirming where a paragraph anchor is", effect: "none here: the walk's anchor is not in doubt (confirmed: false)" },
  "POST /api/nodes/:id/block-to-child": { why: "a paragraph into a child note (one undoable edit)", effect: "event" },
  "POST /api/nodes/:id/duplicate": { why: "a copy of a note it may read, in a space it may write", effect: "event" },
  "POST /api/nodes/:id/export-preview": { why: "one note as Markdown or HTML: it may read the note (owner decision, round 3)", effect: "answer" },
  "POST /api/nodes/:id/ink-versions/:eventId/restore": { why: "a drawing back to an earlier version (undoable)", effect: "event" },
  "POST /api/nodes/:id/suggested-links": { why: "suggestions for a note it may read (a read)", effect: "answer" },
  "POST /api/nodes/:id/tasks": { why: "a task inside a note it may edit", effect: "event" },
  "POST /api/tasks": { why: "a new task in a space it may write (named: SESSION_REQUESTS)", effect: "event" },
  "POST /api/canvases": { why: "a new whiteboard in a space it may write (named: SESSION_REQUESTS)", effect: "event" },
  "POST /api/nodes/:id/undelete": { why: "a note back from the trash", effect: "event" },
  "POST /api/nodes/:id/versions/:versionId/restore": { why: "a note back to an earlier version (undoable)", effect: "event" },
  "POST /api/nodes/:id/views": { why: "a new saved view", effect: "event" },
  "POST /api/pointers": { why: "a pointer to a note it may read (deleting one is refused)", effect: "event" },
  "POST /api/query": { why: "a query over what it may read (a read)", effect: "answer" },
  "POST /api/sync": { why: "what changed, for the notes it may read (a read)", effect: "answer" },
  "POST /api/sync/bodies": { why: "note bodies it may read (a read)", effect: "answer" },
  "POST /api/sync/drawings": { why: "drawings it may read (a read)", effect: "answer" },
  "POST /api/sync/nodes": { why: "notes it may read (a read)", effect: "answer" },
  "POST /api/tags": { why: "a new tag: tags are the workspace's, and it may already tag notes (owner decision, round 3)", effect: "event" },
  "POST /api/tags/resolve-path": { why: "a tag path made on the way to tagging", effect: "event" },
  "POST /api/tasks/:id/place": { why: "a task put into a note it may edit", effect: "event" },
  "POST /api/tasks/:id/unplace": { why: "a task taken out of a note (its block follows the text)", effect: "event" },
  "PUT /api/nodes/:id/attributes/:key": { why: "a field set (a person's value, undoable)", effect: "event" },
  "PUT /api/nodes/:id/position": { why: "where a note sits on the graph (an arrangement)", effect: "event" },
  "PUT /api/nodes/:id/tags/:tagId": { why: "a tag put on a note it may edit (undoable)", effect: "event" },
  "PUT /api/review/cards/:nodeId": { why: "a note made a review card (undoable; the progress is the person's and is not written)", effect: "event" },
};

/** Routes that answer the session neither a refusal (401/403) nor a success: what it gets, and why the walk cannot do better. */
const NEITHER: Record<string, string> = {
  "POST /api/agent-sessions/:id/insert-reply": "404: an AI conversation is shown only to whoever started it and the owner (agentSessions.ts sessionView); a session starts none",
  "POST /api/agent-sessions/:id/revert": "404: as insert-reply (sessionView); a session starts no AI conversation",
  "POST /api/nodes/:id/block-links": "409 'the part changed': the world's one-line notes give no paragraph at that offset (NO_POSITIVE); a link in a note it may edit, undoable",
  "POST /api/nodes/:id/expand-child": "409 embed_not_found: the world has no note that is one embed line (NO_POSITIVE); an undoable edit of a note it may edit",
};

/** Fields a write may replace without an inverse because they are a name or an arrangement the person can set back by hand (round 4: allowed). */
const RENAME_OR_ARRANGEMENT = new Set([
  "content_nodes.title",                // a whiteboard renamed (CANVAS_UPDATED); a note's title is NODE_UPDATED, which is undoable anyway
  "function_refs.config.key:name",      // a saved view renamed
  "function_refs.config.key:pin_order", // a saved view moved in the list
  "function_refs.config.key:updated_at",
  "node_positions.x", "node_positions.y", "node_positions.*", // a card or a note moved
]);

/** Session requests that took something away (a stamp's tombstone or an overwrite outside RENAME_OR_ARRANGEMENT, or a row gone or changed in a
 *  table with no stamps) and are let through because they wrote a restorable root event: why that root's restore brings back what they took. */
// ratchet:list session-relying-on-root
const RELYING_ON_ROOT: Record<string, string> = {
  "DELETE /api/canvases/:id": "content_nodes.deleted: the whiteboard into the trash; NODE_DELETED's restore brings it back",
  "DELETE /api/nodes/:id": "content_nodes.deleted: the note into the trash; NODE_DELETED's restore (or undelete) brings it back",
  "POST /api/nodes/:id/undelete": "content_nodes.deleted: out of the trash; NODE_UNDELETED's restore puts it back in",
  "POST /api/events/:event_id/restore": "content_nodes.deleted (the walk restores a deletion): NODE_UNDELETED, itself restorable",
  "POST /api/history/rewinds/:rewindId/undo": "content_nodes.deleted (the undo brings a note back): NODE_UNDELETED, itself restorable",
  "DELETE /api/nodes/:id/attributes/:key": "node_attributes: the row removed; ATTRIBUTE_DELETED records it whole (prev_field_values) and its restore writes it back",
  "PUT /api/nodes/:id/attributes/:key": "node_attributes.value overwritten; ATTRIBUTE_SET records the earlier value and its restore writes it back",
  "PATCH /api/tasks/:id": "a task's `_task_*` value overwritten; ATTRIBUTE_SET per field, each restorable",
  "POST /api/events/:event_id/revert-conflict": "node_attributes.value: the conflict's earlier value put back; ATTRIBUTE_SET, restorable",
  "DELETE /api/nodes/:id/tags/:tagId": "node_tags: the tag taken off; TAG_REMOVED, undone by tagMembership.ts's restore",
  "PATCH /api/nodes/:id": "content_nodes.parent and sort (the walk moves the note); NODE_UPDATED records the earlier ones (prev_field_values)",
  "POST /api/history/agent-runs/:runId/undo": "content_nodes.body: an AI's edit undone; NODE_UPDATED with its inverse patch, restorable",
  "POST /api/nodes/:id/block-to-child": "content_nodes.body: the paragraph leaves the text for the new child; NODE_UPDATED with its inverse patch",
  "POST /api/tasks/:id/place": "content_nodes.body, parent and sort (the task's line goes into the note, the task under it): the NODE_UPDATED of each, restorable",
  "POST /api/tasks/:id/unplace": "the line leaves the note (body; its block node and block reference follow the text) and the task its parent: NODE_UPDATED of each, restorable; the block rows are derived from the text and come back with it",
};

/** The routes of the class "cannot be undone" a session can reach (§2d of the proposal): each refuses a session, and only a session. */
const IRREVERSIBLE_ROUTES = ["POST /api/history/deleted/purge", "POST /api/nodes/:id/purge", "DELETE /api/nodes/:id/views/:viewId", "DELETE /api/edges/:id",
  "DELETE /api/pointers/:id", "DELETE /api/ai/panel-chat/:nodeId"];

/** Where the sweep's request (helpers/sweepWriteBodies.ts, written for the owner) is refused to the session only because of how the world is set up,
 *  not by a session rule, the session gets a request it is allowed to make (round 5, point 2): a new canvas or task without `space_id` is refused
 *  when the caller may write in more than one space and has no default (the owner has one; the session is given every space). Result with the
 *  space named: the write goes through (adding content is a session's), listed in SESSION_ROUTES. */
const SESSION_REQUESTS: Record<string, (own: SweepObjects, world: SweepObjects) => SweepRequest> = {
  "POST /api/canvases": (_own, world) => ({ json: { title: "Sweep canvas", space_id: world.space } }),
  "POST /api/tasks": (_own, world) => ({ json: { title: "Sweep task", space_id: world.space } }),
};

/** A refusal counts when it is a session's rule, not a permission the session happens to lack in this world (round 5, point 2): an authority
 *  refusal whose reason is one of these, requirePerson's (its reason is the capability; recognised by its fixed message), or an answer code below. */
const SESSION_RULE_REASONS = new Set([
  "session",              // assertMayReachOut, own_personal, assertKeepsReaders: a session never does it
  "session_irreversible", // assertUndoableBy
  "owner", "principal", "role", "not_workspace_owner", "snapshot", // the workspace owner's: a session's actor never is (ownerTransfer.ts gives only to a person)
  "reserved",             // the workspace settings' nodes: the owner's
]);
const PERSON_ONLY = "this is reserved to a person"; // spine/authority.ts requirePerson
const SESSION_RULE_CODES = new Set([
  "session_scope",    // app.ts: a session never uses the AI tool surface
  "owner_only",       // routes/actors.ts and owner transfer: the workspace owner's
  "human_required",   // starting an AI (aiSessionStart, the panel chat, selection actions): a person's
  "push_humans_only", // routes/push.ts: a person's device
]);
/** Is this answer a session's rule? Judged by the refusal that made it (`answered`, recorded where the error handler maps it), or, when the
 *  route answered a coded error of its own, by that code; never by another refusal built while the request ran. */
function refusedByRule(a: { code: string; answered: null | { reason: string; message: string } }): boolean {
  return a.answered ? SESSION_RULE_REASONS.has(a.answered.reason) || a.answered.message.startsWith(PERSON_ONLY) : SESSION_RULE_CODES.has(a.code);
}

/** Refused by a rule a session can never meet, but answered without a session-specific reason; each says why it is structural, not the world. */
// ratchet:list session-refusals-structural
const STRUCTURAL_REFUSALS: Record<string, string> = {
  "DELETE /api/spaces/:id": "a space's `manage`: the owner of a personal space is a person, a shared one is managed by the workspace owner (spaceAccess.ts)",
  "PATCH /api/spaces/:id": "a space's `manage` (as above)",
  "PUT /api/spaces/:id/members/:actorId": "a space's `manage` (as above)",
  "DELETE /api/spaces/:id/members/:actorId": "a space's `manage` (as above)",
  "POST /api/inbox/:event_id/:decision{approve|reject}": "the reviewer is the workspace owner (reviewerDenied → reviewAuthority)",
  "POST /api/inbox/approvals/:id/:decision{approve|reject}": "the reviewer is the workspace owner (as above)",
  "POST /api/inbox/batch": "the reviewer is the workspace owner (as above)",
  "POST /api/inbox/groups/:root_event_id/:decision{approve|reject}": "the reviewer is the workspace owner (as above)",
  "POST /api/agent-sessions/:id/cancel": "only who started an AI session ends it, and a session starts none (aiSessionStart refuses it)",
};

const ANOTHER_DEVICE = randomUUID(); // what the untrusted computer says its device is (any id: another node's, its browser's)
const OWNER_DEVICE = randomUUID();
const TIMED_OUT = 599;

/** Tables a session's write can change that carry no stamps (round 5, point 4): what disappears from them or is overwritten is read by comparing
 *  the rows before and after each request (by primary key, read from the catalog; a row's content by md5 of the row). node_attributes counts
 *  only for the sources the stamp trigger leaves alone; publish_snapshots only for what it says was taken off the site. */
const UNSTAMPED_TABLES = ["block_nodes", "note_block_refs", "ink_chunks", "ink_manifests", "media_uploads", "ai_suggestions", "event_reviews"];
const keyColumns = new Map<string, string[]>();
async function unstampedRows(ws: string): Promise<Map<string, string>> {
  const rows = new Map<string, string>();
  for (const table of UNSTAMPED_TABLES) {
    if (!keyColumns.has(table)) {
      keyColumns.set(table, (await q<{ c: string }>(
        `SELECT kcu.column_name AS c FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
          WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY' ORDER BY kcu.ordinal_position`, [table])).rows.map((r) => r.c));
    }
    const key = keyColumns.get(table)!.map((c) => `t.${c}::text`).join(" || '|' || ") || "md5(t::text)";
    for (const r of (await q<{ k: string; h: string }>(`SELECT ${key} AS k, md5(t::text) AS h FROM ${table} t WHERE t.workspace_id = $1`, [ws])).rows) rows.set(`${table}.row:${r.k}`, r.h);
  }
  for (const r of (await q<{ k: string; h: string }>(`SELECT id::text AS k, md5(a::text) AS h FROM node_attributes a WHERE workspace_id = $1 AND coalesce(source, '') NOT IN ('ui', 'explicit', 'dispatcher')`, [ws])).rows) rows.set(`node_attributes.unstamped:${r.k}`, r.h);
  for (const r of (await q<{ k: string; h: string }>(`SELECT id::text AS k, md5(coalesce(payload->'taken_down', '[]'::jsonb)::text) AS h FROM publish_snapshots WHERE workspace_id = $1`, [ws])).rows) rows.set(`publish_snapshots.taken_down:${r.k}`, r.h);
  return rows;
}
/** What disappeared or was overwritten between two readings, as `{ field: "<table>.<what>", deleted, overwrote }` (the stamps' shape). */
function unstampedTaken(before: Map<string, string>, after: Map<string, string>): Array<{ field: string; deleted: boolean; overwrote: boolean }> {
  const out: Array<{ field: string; deleted: boolean; overwrote: boolean }> = [];
  for (const [k, h] of before) {
    const field = k.slice(0, k.indexOf(":"));
    if (!after.has(k)) out.push({ field, deleted: true, overwrote: false });
    else if (after.get(k) !== h) out.push({ field, deleted: false, overwrote: true });
  }
  return out;
}

describe.skipIf(!isTestDatabase())("a temporary session's writes carry its id nowhere but as the author of a stamp", { timeout: 900_000 }, () => {
  let D: SweepSide;
  let o: SweepObjects;
  let credential = "", credentialHash = "", sessionActorId = "", sessionId = "";
  let aiService: Awaited<ReturnType<typeof startFakeMessagesService>> | undefined;
  const answered = new Map<string, number[]>();
  const refusedWith = new Map<string, string[]>();
  /** Per refused session request: the answer's code and the refusal that made the answer (recorded where the app's error handler turns it into the response). */
  const whyRefused = new Map<string, Array<{ status: number; code: string; answered: null | { reason: string; message: string } }>>();
  /** The events each successful session request wrote (route → event types and tx_meta), to judge against the restore contract. */
  const wroteBy = new Map<string, Array<{ event_type: string; tx_meta: unknown; root: boolean }>>();
  /** Per successful session request: its events and what its stamps say it removed or overwrote. */
  const changedBy = new Map<string, Array<{ events: Array<{ event_type: string; tx_meta: unknown; root: boolean }>; changed: Array<{ field: string; deleted: boolean; overwrote: boolean }> }>>();
  /** The two writes of round 4 that take something away with no inverse: as the session (refused) and as the owner (allowed). */
  const takeAway = { session: new Map<string, number>(), owner: new Map<string, number>() };
  /** Round 5: moving a note out of a members_can_move_out space, as the session (refused, the note stays) and as the owner (moved). */
  const moves = { session: 0, sessionReasons: [] as string[], sessionSpace: false, owner: 0, ownerSpace: false };
  /** Round 6: PATCH hidden: false on a hidden note, as the session (refused, it stays hidden) and as the owner (shown). */
  const shown = { session: 0, sessionReasons: [] as string[], sessionStillHidden: false, owner: 0, ownerStillHidden: true };
  /** Routes the session got a 2xx with a body from (for the kinds that only read). */
  const readBack = new Set<string>();
  const noRequest: string[] = [];
  let ownerStatus = 0, sessionSaveStatus = 0;
  const ownerAnswered = new Map<string, number[]>();

  /** Routes whose own request added an upload of the session (not the workspace's count: round 5). */
  const mediaAdded = new Set<string>();
  const sessionMedia = async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM media_uploads WHERE workspace_id = $1 AND uploader_actor_id::text = $2`, [D.ws, sessionActorId])).rows[0]!.n);

  const asSession = async (path: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit }) => {
    const res = await Promise.race([
      app.request(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${credential}`, "x-onden-device-id": ANOTHER_DEVICE } }),
      new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null, { status: TIMED_OUT })), 15_000)),
    ]);
    const text = await res.text().catch(() => "");
    let code = "";
    try { code = String((JSON.parse(text) as { error?: unknown }).error ?? ""); } catch { /* not JSON */ }
    await awaitAllDispatchers();
    return { status: res.status, code, body: text };
  };

  beforeAll(async () => {
    process.env.ONDEN_SECRET_KEY = SWEEP_SECRET_KEY;
    aiService = await startFakeMessagesService();
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = aiService.url;
    const w = await freshWorkspace("sessionWrites");
    await setModulesOn(w.ws, null);
    D = { ws: w.ws, owner: w.actor, ownerExternalId: `sessionWrites-${randomUUID()}` };
    await q(`UPDATE actors SET external_id = $2 WHERE id = $1`, [D.owner.id, D.ownerExternalId]); // the owner's one signed-in control save
    workspaceSwitch.ws = D.ws;
    o = await buildSweepObjects(D, "S");
    // every route's own fresh objects (the sweep's positive pass does the same), all made BEFORE the session is opened, so a space one of
    // them makes is among the ones the session is given
    const writes = mountedRoutes(app, (m) => ["POST", "PUT", "PATCH", "DELETE"].includes(m)).filter((r) => !r.path.startsWith("/api/auth"));
    const planned: Array<{ route: string; method: string; path: string; content: NonNullable<typeof WRITE_CONTENT[string]>; own: SweepObjects }> = [];
    for (const r of writes) {
      const content = WRITE_CONTENT[keyOf(r)];
      if (!content) { noRequest.push(keyOf(r)); continue; }
      const own = await buildSweepObjects(D, "S", fieldsUsed(content));
      planned.push({ route: keyOf(r), method: r.method, path: r.path, content, own });
    }
    // two notes with an anchored paragraph (a review card's paragraph gets one): a save that changes the anchor records an event that names the save's device
    const anchored = async (label: string) => (await createNote({ actor: D.owner, workspaceId: D.ws, spaceId: null, event: { uiContext: "test.sweep" },
      title: `${o.canary}${label}`, markdown: `${o.canary}${label} a paragraph on its own {review}\n\nsecond` })).node.id as string;
    const sessionAnchored = await anchored("SessionAnchored"), ownerAnchored = await anchored("OwnerAnchored");

    // a note in a shared space its members may move notes out of (members_can_move_out), for the session and for the owner, and a second space:
    // the session can write both, so only the session's rule can refuse it moving a note across (round 5, point 2)
    const movable = await makeSpace(D.ws, `${o.canary}MoveOut`, [{ id: D.owner.id, permission: "edit" }], { publish: false, external_ai: true, backup: true, members_can_move_out: true });
    const moveTarget = await makeSpace(D.ws, `${o.canary}MoveIn`, [{ id: D.owner.id, permission: "edit" }]);
    const movingNote = async (label: string) => (await createNote({ actor: D.owner, workspaceId: D.ws, spaceId: movable, event: { uiContext: "test.sweep" },
      title: `${o.canary}${label}`, markdown: "a note to move" })).node.id as string;
    const sessionMoving = await movingNote("SessionMoving"), ownerMoving = await movingNote("OwnerMoving");
    // a hidden note each (an inbox item): showing it (PATCH hidden: false) is promote by another door (round 6, point 3)
    const hiddenNote = async (label: string) => (await createNote({ actor: D.owner, workspaceId: D.ws, spaceId: null, hidden: true, event: { uiContext: "test.sweep" },
      title: `${o.canary}${label}`, markdown: "a hidden note" })).node.id as string;
    const sessionHidden = await hiddenNote("SessionHidden"), ownerHidden = await hiddenNote("OwnerHidden");

    // the session reaches every live space of the workspace, with edit: the widest a session can be
    const spaces: string[] = [];
    for (const { id } of (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND deleted_at IS NULL`, [D.ws])).rows) {
      const access = await spaceAccess(D.owner, id);
      if (access?.read && access.write) spaces.push(id); // the owner may give only what they hold
    }
    const opened = await openTemporarySession(D.owner, D.ws, { spaces: spaces.map((spaceId) => ({ spaceId, permission: "edit" as const })) }, await ticketWithoutEvidence(D.owner, "open_session"));
    credential = opened.credential; sessionId = opened.sessionId;
    sessionActorId = (await resolveTemporarySessionActor(credential, D.ws))!.id;
    credentialHash = (await q<{ h: string }>(`SELECT credential_hash AS h FROM participant_sessions WHERE id = $1::uuid`, [sessionId])).rows[0]!.h;

    // the walk: every write route, as the session. Opening it changed who can see the spaces (membership_epoch): a request that confirms the
    // audience carries the epoch as it is now, as the screen would read it before asking
    const epoch = (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [D.ws])).rows[0]!.e;
    for (const p of planned) {
      const own = { ...p.own, epoch };
      const sessionRequest = SESSION_REQUESTS[p.route];
      for (const req of (sessionRequest ? [sessionRequest(own, o)] : asList(p.content(own, own))) as SweepRequest[]) {
        const qs = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
        const headers: Record<string, string> = { ...req.headers };
        let body: BodyInit | undefined;
        if (req.raw) { headers["content-type"] = req.raw.contentType; body = req.raw.bytes as unknown as BodyInit; }
        else if (req.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(req.json); }
        const before = (await q<{ m: string }>(`SELECT coalesce(max(id), 0)::text AS m FROM domain_events WHERE workspace_id = $1`, [D.ws])).rows[0]!.m;
        const seqBefore = (await q<{ m: string }>(`SELECT coalesce(max(seq), 0)::text AS m FROM sync_stamps WHERE workspace_id = $1`, [D.ws])).rows[0]!.m;
        const rowsBefore = await unstampedRows(D.ws);
        const mediaBefore = await sessionMedia();
        raised.answered = null;
        const { status, code, body: answer } = await asSession(fillPath(p.path, req.params) + qs, { method: p.method, headers, body });
        if (status >= 200 && status < 300 && await sessionMedia() > mediaBefore) mediaAdded.add(p.route);
        answered.set(p.route, [...(answered.get(p.route) ?? []), status]);
        if (status === 401 || status === 403) whyRefused.set(p.route, [...(whyRefused.get(p.route) ?? []), { status, code, answered: raised.answered }]);
        if (status >= 200 && status < 300 && answer.length > 2) readBack.add(p.route);
        if (status === 403) refusedWith.set(p.route, [...(refusedWith.get(p.route) ?? []), code]);
        if (status >= 200 && status < 300) {
          const events = (await q<{ event_type: string; tx_meta: unknown; root: boolean }>(
            // `root`: not caused by another event, or a restore's own event (its triggered_by names the event it undoes; it is undone in its turn). What a cascade derives (a block node from the text) is undone with its root (restoreEvent's cascade).
            `SELECT event_type, tx_meta, (triggered_by_event_id IS NULL OR tx_meta ? 'restored_from') AS root FROM domain_events WHERE workspace_id = $1 AND id > $2::bigint AND actor_id = $3`,
            [D.ws, before, sessionActorId])).rows;
          wroteBy.set(p.route, [...(wroteBy.get(p.route) ?? []), ...events]);
          // what it took away or replaced, read from the stamps its write left (a tombstone; a stamp that saw an earlier write of that field)
          const changed = (await q<{ field: string; deleted: boolean; overwrote: boolean }>(
            `SELECT table_name || '.' || field AS field, deleted, saw <> '{}'::jsonb AS overwrote FROM sync_stamps
              WHERE workspace_id = $1 AND seq > $2::bigint AND author = $3`, [D.ws, seqBefore, sessionActorId])).rows;
          // and what it took from the tables with no stamps
          changed.push(...unstampedTaken(rowsBefore, await unstampedRows(D.ws)));
          changedBy.set(p.route, [...(changedBy.get(p.route) ?? []), { events, changed }]);
        }
      }
    }
    // Two kinds whose walk request has nothing to do (the rewind goes back to "now"; the version restored is the one the note has): one request each
    // that does, so the kind is shown to WORK for a session, not only to answer 2xx.
    const sessionEvents = async (route: string, run: () => Promise<{ status: number }>) => {
      const before = (await q<{ m: string }>(`SELECT coalesce(max(id), 0)::text AS m FROM domain_events WHERE workspace_id = $1`, [D.ws])).rows[0]!.m;
      const { status } = await run();
      expect([route, status]).toEqual([route, 200]);
      const events = (await q<{ event_type: string; tx_meta: unknown; root: boolean }>(
        `SELECT event_type, tx_meta, (triggered_by_event_id IS NULL OR tx_meta ? 'restored_from') AS root FROM domain_events WHERE workspace_id = $1 AND id > $2::bigint AND actor_id = $3`,
        [D.ws, before, sessionActorId])).rows;
      wroteBy.set(route, [...(wroteBy.get(route) ?? []), ...events]);
    };
    const edited = (await createNote({ actor: D.owner, workspaceId: D.ws, spaceId: null, title: `${o.canary}Edited`, markdown: `${o.canary} first words`, event: { uiContext: "test.sweep" } })).node.id as string;
    const firstSave = (await q<{ id: string }>(`SELECT max(id)::text AS id FROM domain_events WHERE workspace_id = $1 AND target_id = $2`, [D.ws, edited])).rows[0]!.id;
    const beforeEdit = (await q<{ t: Date }>(`SELECT now() AS t`)).rows[0]!.t;
    await updateNode(D.ws, edited, { markdown: `${o.canary} words written later` }, { actor: D.owner });
    await sessionEvents("POST /api/nodes/:id/versions/:versionId/restore", () => asSession(`/api/nodes/${edited}/versions/${firstSave}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    await updateNode(D.ws, edited, { markdown: `${o.canary} and written once more` }, { actor: D.owner });
    await sessionEvents("POST /api/history/rewind", () => asSession("/api/history/rewind", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ t: beforeEdit.toISOString(), restore_ids: [edited], undelete_ids: [], delete_ids: [] }) }));

    // Round 4: changing a view's settings and taking cards off a board have no inverse: the session is refused, the owner is not. Each at its own
    // view / board (the owner's comes after, at a fresh pair).
    const takeAwayPair = async () => {
      const own = await buildSweepObjects(D, "T", new Set(["note", "noteView", "canvas"] as const));
      await q(`SELECT 1`); // (objects are made by the owner, in the default space the session reaches)
      return own;
    };
    for (const who of ["session", "owner"] as const) {
      const own = await takeAwayPair();
      const viewPatch = JSON.stringify({ filters: [] });
      const boardPatch = JSON.stringify({ cards: { remove: [own.note] } });
      const request = async (path: string, method: string, body: string) => {
        if (who === "session") return (await asSession(path, { method, headers: { "content-type": "application/json" }, body })).status;
        signedIn.as = D.ownerExternalId;
        try { const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body }); await res.arrayBuffer(); return res.status; } finally { signedIn.as = ""; }
      };
      // the board first gets the card (a placing, allowed to both), then loses it
      await request(`/api/boards/${own.canvas}`, "PATCH", JSON.stringify({ cards: { upsert: [{ nodeId: own.note, x: 1, y: 1 }] } }));
      takeAway[who].set("a view's settings", await request(`/api/nodes/${own.note}/views/${own.noteView}`, "PATCH", viewPatch));
      takeAway[who].set("a board's card taken off", await request(`/api/boards/${own.canvas}`, "PATCH", boardPatch));
    }

    // moving a note to another space: the session is refused by its rule (assertKeepsReaders), the owner moves its own
    const moveBody = (note: string) => JSON.stringify({ node_id: note, to_space_id: moveTarget, membership_epoch: epochNow() });
    const epochNow = () => movedEpoch;
    let movedEpoch = (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [D.ws])).rows[0]!.e;
    raised.answered = null;
    moves.session = (await asSession("/api/spaces/move", { method: "POST", headers: { "content-type": "application/json" }, body: moveBody(sessionMoving) })).status;
    moves.sessionReasons = answeredReasons();
    moves.sessionSpace = (await q<{ s: string }>(`SELECT space_id::text AS s FROM content_nodes WHERE id = $1`, [sessionMoving])).rows[0]!.s === movable;
    movedEpoch = (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [D.ws])).rows[0]!.e;
    signedIn.as = D.ownerExternalId;
    try {
      const res = await app.request("/api/spaces/move", { method: "POST", headers: { "content-type": "application/json" }, body: moveBody(ownerMoving) });
      moves.owner = res.status; await res.arrayBuffer();
    } finally { signedIn.as = ""; }
    moves.ownerSpace = (await q<{ s: string }>(`SELECT space_id::text AS s FROM content_nodes WHERE id = $1`, [ownerMoving])).rows[0]!.s === moveTarget;

    // showing a hidden note through the ordinary save: the session is refused by its rule (nodeUpdate.ts assertMayShowHidden), the owner shows its own
    const isHidden = async (id: string) => (await q<{ h: boolean }>(`SELECT hidden AS h FROM content_nodes WHERE id = $1`, [id])).rows[0]!.h;
    raised.answered = null;
    shown.session = (await asSession(`/api/nodes/${sessionHidden}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ hidden: false }) })).status;
    shown.sessionReasons = answeredReasons();
    shown.sessionStillHidden = await isHidden(sessionHidden);
    signedIn.as = D.ownerExternalId;
    try {
      const res = await app.request(`/api/nodes/${ownerHidden}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ hidden: false }) });
      shown.owner = res.status; await res.arrayBuffer();
    } finally { signedIn.as = ""; }
    shown.ownerStillHidden = await isHidden(ownerHidden);

    // an editor save names its device in the body too (body_change.device, recorded on the block-anchor events): the session names another one there
    // (the save takes the anchored paragraph out: the anchor is lost, and that event names the device)
    const rewrite = (label: string) => JSON.stringify({ markdown: "second", body_change: { changes: [], device: label === "SessionAnchored" ? ANOTHER_DEVICE : OWNER_DEVICE } });
    sessionSaveStatus = (await asSession(`/api/nodes/${sessionAnchored}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: rewrite("SessionAnchored") })).status;
    // control: the owner's own save records the device it names (the rule takes only a session's away)
    signedIn.as = D.ownerExternalId;
    try {
      // and the owner still does what the session may not (each at fresh objects of its own): the class refuses a session only
      for (const route of IRREVERSIBLE_ROUTES) {
        const content = WRITE_CONTENT[route]!;
        const own = await buildSweepObjects(D, "O", fieldsUsed(content));
        const [method, path] = route.split(" ") as [string, string];
        for (const req of asList(content(own, own)) as SweepRequest[]) {
          const res = await app.request(fillPath(path, req.params), { method, headers: { "content-type": "application/json" }, body: req.json === undefined ? undefined : JSON.stringify(req.json) });
          await res.arrayBuffer();
          await awaitAllDispatchers();
          ownerAnswered.set(route, [...(ownerAnswered.get(route) ?? []), res.status]);
        }
      }
      const ownerSave = await app.request(`/api/nodes/${ownerAnchored}`, { method: "PATCH", headers: { "content-type": "application/json", "x-onden-device-id": OWNER_DEVICE }, body: rewrite("OwnerAnchored") });
      ownerStatus = ownerSave.status;
      await ownerSave.arrayBuffer();
    } finally { signedIn.as = ""; }
  }, 900_000);

  afterAll(async () => {
    workspaceSwitch.ws = ""; delete process.env.ONDEN_SECRET_KEY; delete process.env.ONDEN_AI_BASE_URL_OVERRIDE;
    await aiService?.close();
  });

  const ok = (status: number) => status >= 200 && status < 300;

  it("every write route had a request and an answer: none was skipped, none timed out", () => {
    expect(noRequest, "a mounted write route has no request in helpers/sweepWriteBodies.ts").toEqual([]);
    expect([...answered].filter(([, statuses]) => statuses.includes(TIMED_OUT)).map(([k]) => k), "timed out (counted as a failure, not a pass)").toEqual([]);
  });

  it("every write route, one by one: refused (401/403), or succeeded with the effect listed for it, or listed with why neither", async () => {
    const refusedRoutes: string[] = [], succeeded: string[] = [], neither: string[] = [];
    for (const [route, statuses] of answered) {
      if (statuses.every((st) => st === 401 || st === 403)) refusedRoutes.push(route);
      else if (statuses.every(ok)) succeeded.push(route);
      else neither.push(route);
    }
    // (a) the routes that succeed are exactly the listed ones, each with why a session may: a new route a session can write fails here until listed
    expect(succeeded.sort(), "routes a session gets a 2xx from: list a new one in SESSION_ROUTES with why it may and what it leaves").toEqual(Object.keys(SESSION_ROUTES).sort());
    // a 404, 409, 422 or 400 is neither refused nor shown to work: each is named with why the walk cannot make it work (or it gets a request that can)
    expect(neither.sort(), "a route answered the session neither a refusal nor a success: give it a request that works, or say why in NEITHER").toEqual(Object.keys(NEITHER).sort());
    // (b) each did what its line says (an event of the session, its upload, an answer to read) — a 2xx with no effect does not count
    const shown = (route: string): boolean => {
      const effect = SESSION_ROUTES[route]!.effect;
      if (effect === "event") return (wroteBy.get(route) ?? []).length > 0;
      if (effect === "media row") return mediaAdded.has(route);
      if (effect === "answer") return readBack.has(route);
      return (wroteBy.get(route) ?? []).length === 0; // "none here": said why, and asserted to write nothing, so the line changes when it does
    };
    expect(succeeded.filter((route) => !shown(route)), "a route answered 2xx but did not do what its line says").toEqual([]);
    // eslint-disable-next-line no-console
    console.info(`[session-writes] ${answered.size} write routes tried as the session: ${succeeded.length} succeeded, ${refusedRoutes.length} refused, ${neither.length} neither (named)`);
    // deciding an AI's suggestion is a person's (routes/aiSuggestions.ts requirePerson): ai_edit_suggestion_items.decided_by is out of a session's reach
    for (const route of ["POST /api/ai-suggestions/:id/accept", "POST /api/ai-suggestions/:id/reject"]) expect(answered.get(route), route).toEqual([403]);
  });

  it("judged by effect: no successful session write took away or overwrote something without an inverse (read from its stamps and events)", () => {
    // A request whose stamps remove a row or replace an earlier value must have a root event the restore contract can undo
    // (restoreContract.ts restoreBlockedReason: null), unless every field it replaced is a name or an arrangement (RENAME_OR_ARRANGEMENT).
    const relying = new Set<string>();
    const bad = [...changedBy].flatMap(([route, requests]) => requests.flatMap(({ events, changed }) => {
      const taken = changed.filter((c) => c.deleted || (c.overwrote && !RENAME_OR_ARRANGEMENT.has(c.field)));
      if (taken.length === 0) return [];
      const undoable = events.some((e) => e.root && restoreBlockedReason(e) === null);
      if (undoable) relying.add(route);
      return undoable ? [] : [`${route}: ${taken.map((c) => `${c.field}${c.deleted ? " removed" : " overwritten"}`).join(", ")} with ${events.map((e) => e.event_type).join(", ") || "no event"}`];
    }));
    // A limit, said and pinned: "the request has a restorable root event" lets through everything that request took away; that the root's restore
    // covers each removed or overwritten thing is not proven item by item. The requests that rely on it are listed with why their root covers them,
    // so a new one is read by a person (round 5, point 4).
    expect([...relying].sort(), "a session request took something away and is let through only because it also wrote a restorable root event: say why the root's restore covers what it took (RELYING_ON_ROOT)").toEqual(Object.keys(RELYING_ON_ROOT).sort());
    expect(bad, "a session took something away that nothing brings back").toEqual([]);
    expect([...changedBy.values()].flat().some((r) => r.changed.some((c) => c.deleted || c.overwrote)), "control: some writes did remove or overwrite (and had an inverse)").toBe(true);
  });

  it("round 5: every refusal is a session's rule, not a permission the session lacks in this world", () => {
    const judged = [...whyRefused].map(([route, answers]) => ({ route, structural: route in STRUCTURAL_REFUSALS,
      byRule: answers.every(refusedByRule) }));
    expect(judged.filter((j) => !j.byRule && !j.structural).map((j) => `${j.route}: ${JSON.stringify(whyRefused.get(j.route))}`),
      "refused by the world, not by a rule: give the session a request it is allowed to make (SESSION_REQUESTS) and judge again").toEqual([]);
    // a structural entry that now answers with a rule (or is no longer refused) leaves the list
    expect(judged.filter((j) => j.structural && j.byRule).map((j) => j.route), "now refused by a session rule: take it off STRUCTURAL_REFUSALS").toEqual([]);
    expect(Object.keys(STRUCTURAL_REFUSALS).filter((route) => !whyRefused.has(route)), "no longer refused: take it off STRUCTURAL_REFUSALS").toEqual([]);
  });

  it("round 6: a hidden note is not shown again by the session through PATCH hidden: false (its rule, it stays hidden); the owner shows its own", () => {
    expect(shown).toEqual({ session: 403, sessionReasons: ["session"], sessionStillHidden: true, owner: 200, ownerStillHidden: false });
  });

  it("round 5: a note is not moved to another space by the session (its rule, the note stays); the owner moves its own", () => {
    expect(moves).toEqual({ session: 403, sessionReasons: ["session"], sessionSpace: true, owner: 200, ownerSpace: true });
  });

  it("round 4: changing a view's settings and taking a card off a board are refused to the session (403) and done by the owner", () => {
    expect(Object.fromEntries(takeAway.session)).toEqual({ "a view's settings": 403, "a board's card taken off": 403 });
    expect(Object.fromEntries(takeAway.owner)).toEqual({ "a view's settings": 200, "a board's card taken off": 200 });
  });

  it("no write the session got through is one that cannot be undone (judged by the restore contract, from the events it wrote)", () => {
    // restoreContract.ts restoreBlockedReason: "irreversible" (a purge) never; "unsupported" (no inverse) only for what adds or rearranges, never for
    // a deletion (*_DELETED, *_REMOVED, *_PURGED): a session's deletions go to the trash or have an inverse
    const removes = /_(DELETED|REMOVED|PURGED|CLEARED)$/;
    const bad = [...wroteBy].flatMap(([route, events]) => events.filter((e) => e.root).flatMap((e) => {
      const why = restoreBlockedReason(e);
      return why === "irreversible" || (why === "unsupported" && removes.test(e.event_type)) ? [`${route}: ${e.event_type} (${why})`] : [];
    }));
    expect(bad, "a session did what cannot be undone").toEqual([]);
    expect([...wroteBy.values()].flat().length, "control: the session's successful writes wrote events").toBeGreaterThan(20);
  });

  it("refuses the session what cannot be undone (403, the class's own refusal), and what would change who is a member of what (403)", () => {
    // the class (docs/architecture/proposals/sessions-reads-own-2026-11-17.md §2d): each answers 403 with the class's own code
    for (const route of IRREVERSIBLE_ROUTES) {
      expect([route, answered.get(route)], route).toEqual([route, [403]]);
      expect([route, ownerAnswered.get(route)?.every((st) => st >= 200 && st < 300)], `${route}: the person still may`).toEqual([route, true]);
      // the app's routes answer an authority refusal with its text (spine/authority.ts IRREVERSIBLE_REFUSAL)
      expect(refusedWith.get(route), route).toEqual(["a temporary session cannot do what cannot be undone"]);
    }
    // a tag's saved view is the owner's (principal_admin) before it is irreversible: refused all the same
    expect(answered.get("DELETE /api/tags/:tagId/views/:viewId")).toEqual([403]);
    // who is a member of what: taking an invite, adding, removing or changing a member, a space's members, the owner, a token, another session, a space
    for (const route of ["POST /api/invites/claim", "POST /api/actors", "POST /api/actors/:id/invite", "PATCH /api/actors/:id", "DELETE /api/actors/:id",
      "PUT /api/spaces/:id/members/:actorId", "DELETE /api/spaces/:id/members/:actorId", "POST /api/workspace/owner-transfer", "POST /api/actors/:id/tokens",
      "POST /api/spaces/sessions", "POST /api/spaces", "DELETE /api/spaces/:id"]) {
      expect([route, answered.get(route)], route).toEqual([route, [403]]);
    }
  });

  it("the carried columns that say who did it record null for the session (not its id, not the opener's)", async () => {
    const refs = (await q<{ created_by: string | null }>(
      `SELECT created_by::text FROM function_refs WHERE workspace_id = $1 AND created_at >= (SELECT created_at FROM participant_sessions WHERE id = $2::uuid)
          AND (holder_node_id IN (SELECT target_id::uuid FROM domain_events WHERE workspace_id = $1 AND actor_id = $3 AND target_type = 'node'))`,
      [D.ws, sessionId, sessionActorId])).rows;
    expect(refs.length, "the session made cards and views").toBeGreaterThan(0);
    expect(refs.filter((r) => r.created_by === sessionActorId || r.created_by === D.owner.id).length, "a card or view the session made names it or its opener").toBe(0);
  });

  it("the device the untrusted computer named is recorded nowhere: not on the session's events, not on its stamps, not in an event's payload", async () => {
    const events = await q<{ n: string; with_device: string }>(
      `SELECT count(*)::text AS n, count(device_id)::text AS with_device FROM domain_events WHERE workspace_id = $1 AND actor_id = $2`, [D.ws, sessionActorId]);
    expect(Number(events.rows[0]!.n), "control: the session wrote events").toBeGreaterThan(0);
    expect(Number(events.rows[0]!.with_device), "a session's event records a device").toBe(0);
    const stamps = await q<{ n: string; with_device: string }>(
      `SELECT count(*)::text AS n, count(device)::text AS with_device FROM sync_stamps WHERE workspace_id = $1 AND author = $2`, [D.ws, sessionActorId]);
    expect(Number(stamps.rows[0]!.n), "control: the session's writes have stamps").toBeGreaterThan(0);
    expect(Number(stamps.rows[0]!.with_device), "a session's stamp records a device").toBe(0);
    const named = await q<{ n: string }>(
      `SELECT ((SELECT count(*) FROM domain_events WHERE workspace_id = $1 AND (device_id::text = $2 OR payload::text LIKE '%' || $2 || '%' OR tx_meta::text LIKE '%' || $2 || '%'))
             + (SELECT count(*) FROM sync_stamps WHERE workspace_id = $1 AND device::text = $2)
             + (SELECT count(*) FROM sync_stamp_heads WHERE workspace_id = $1 AND device::text = $2))::text AS n`, [D.ws, ANOTHER_DEVICE]);
    expect(Number(named.rows[0]!.n), "the session's device id is stored").toBe(0);
    expect([sessionSaveStatus, ownerStatus], "control: the session's and the owner's saves of an anchored paragraph were accepted").toEqual([200, 200]);
    // control: the owner's save records the device it named, on its event, its stamps and (body_change) the block-anchor event of the paragraph it added
    const owner = await q<{ events: string; stamps: string; anchors: string }>(
      `SELECT (SELECT count(*) FROM domain_events WHERE workspace_id = $1 AND device_id::text = $2)::text AS events,
              (SELECT count(*) FROM sync_stamps WHERE workspace_id = $1 AND device::text = $2)::text AS stamps,
              (SELECT count(*) FROM domain_events WHERE workspace_id = $1 AND payload->>'device' = $2)::text AS anchors`, [D.ws, OWNER_DEVICE]);
    expect(owner.rows[0]).toEqual({ events: expect.not.stringMatching(/^0$/), stamps: expect.not.stringMatching(/^0$/), anchors: expect.not.stringMatching(/^0$/) });
  });

  it("a snapshot (pages and digest) and a change bundle hold the session's ids only as the author of a stamp, and never its credential or its hash", async () => {
    let pages = "", pagesWithAuthors = "";
    const summary = await readStampedPages(D.owner, D.ws, { since: null, layer: "rows" }, async (page) => { pages += withoutStampAuthors(page); pagesWithAuthors += JSON.stringify(page); });
    const bundle = await readChangeBundle(D.owner, D.ws, {});
    const wire = { snapshot: pages, digest: JSON.stringify(summary), bundle: withoutStampAuthors(bundle) };
    const needles = { "session actor id": sessionActorId, "session id": sessionId, credential, "credential hash": credentialHash, "credential's sha256": sha256Hex(credential), "the session's device": ANOTHER_DEVICE };
    const found = Object.entries(wire).flatMap(([where, text]) => Object.entries(needles).filter(([, needle]) => text.includes(needle)).map(([what]) => `${what} in the ${where}`));
    expect(found, "found on the wire (only names are printed, never the values)").toEqual([]);
    // the digest is of the same read: it lists the carried tables
    expect(summary.digest.length, "control: the digest was read").toBeGreaterThan(0);
    // control: the stamps of its writes do name it, as their author
    expect(pagesWithAuthors.includes(sessionActorId)).toBe(true);
    expect(JSON.stringify(bundle).includes(sessionActorId)).toBe(true);
  });

  it("self-test: a refusal is judged by the one that made the answer, not by others raised on the way", () => {
    expect(refusedByRule({ code: "forbidden", answered: { reason: "session", message: "x" } })).toBe(true);
    expect(refusedByRule({ code: "forbidden", answered: { reason: "space", message: "space access is below required 'write'" } })).toBe(false);
    expect(refusedByRule({ code: "owner_only", answered: null })).toBe(true);
    expect(refusedByRule({ code: "forbidden", answered: null })).toBe(false);
  });

  it("self-test: only a stamp's author is taken out, not a key that happens to be called author", () => {
    const row = { table: "t", values: { author: "ROW-AUTHOR", title: "x" }, stamps: [{ origin: "n", seq: 1, wall: 1, counter: 0, author: "STAMP-AUTHOR", device: null }] };
    const out = withoutStampAuthors(row);
    expect(out).toContain("ROW-AUTHOR");
    expect(out).not.toContain("STAMP-AUTHOR");
  });
});
