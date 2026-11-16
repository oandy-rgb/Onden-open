// Write permission matrix — permissionMatrix.test.ts for the WRITE surface.
//
// The endpoint inventory is INTROSPECTED from the real assembled app
// (src/index.ts, modules included): every mounted POST / PUT / PATCH / DELETE.
// Two completeness gates keep a new write route from slipping past:
//   - PARAM_FILL: a path param this file cannot fill FAILS the suite;
//   - BODY_FILL:  a route with no entry in the body table FAILS the suite
//                 (`none` is an entry: "this route reads no body").
//
// World (all names carry STAMP so the shared test database stays shareable):
//   owner     the workspace owner (steps into every shared space)
//   viewer    a member with VIEW on space V
//   editor    a member with EDIT on space E, and no access to space R
//   token     a bearer token whose agent is in no space
// Each of V, E and R holds a note (+ a linked note), a tag, an edge between
// the notes, a canvas and an event; every title / body / slug is unique.
//
// For every write route:
//   (a) anonymous                        → 401
//   (b) viewer, aimed at V's objects     → never 2xx, V's rows unchanged
//   (c) editor, aimed at R's objects     → never 2xx, R's rows unchanged,
//                                          R's markers absent from the response
//   (d) bearer token, agent in no space  → 403 token_scope outside /api/mcp/*
// "Unchanged" = the content_nodes rows (markdown, title, parent, space,
// deleted_at, tag_schema), their attributes, edges, tag memberships and the
// space's own row and members, plus the count of domain_events about them.
// Two sanity cases prove the setup works: the editor CAN edit E's note and
// the owner CAN edit R's, so the matrix cannot pass by everything failing for
// a wrong reason.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { createToken } from "../services/agentTokens.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { mountedRoutes, type MountedRoute } from "./helpers/appRoutes.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { __setPageFetchForTests } from "../modules/rss/fetch.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();

// ── Controllable session (better-auth mocked; identity resolved from the REAL
//    actors table via external_id, as in permissionMatrix.test.ts) ───────────
let sessionExternalId: string | null = null;
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: {
      getSession: vi.fn(async () =>
        sessionExternalId
          ? { user: { id: sessionExternalId, name: "Write Matrix", email: `${sessionExternalId}@matrix.test` } }
          : null),
    },
    // internalAdapter: the people here have no password account, which is what POST /api/fresh-proof asks the library about (409 fresh_proof_no_password)
    $context: Promise.resolve({ runMigrations: async () => {}, internalAdapter: { findAccounts: async () => [] } }),
  },
}));

const { app } = await import("../app.js");

const STAMP = `${Date.now()}`;

/** The objects one space holds, and the markers that must never leak out of R. */
type Group = {
  space: string; note: string; linked: string; tag: string; tag2: string; edge: string; canvas: string; event: string;
  trashed: string; feed: string; article: string; pointer: string; task: string; noteView: string; tagView: string;
  title: string; body: string; slug: string;
};
type World = { epoch: string; ws: string; V: Group; E: Group; R: Group; bystander: string; bystanderToken: string; ownerId: string };

// ── Path params ────────────────────────────────────────────────────────────
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** Value for each `:param`, by the object the route is about. An UNKNOWN param
 *  throws — the completeness gate for newly mounted parameterized routes. */
function fillPath(path: string, g: Group, w: World): string {
  return path.replace(/:([A-Za-z_]+)(?:\{[^}]*\})?/g, (_m, name: string) => {
    switch (name) {
      case "id":
        if (path.startsWith("/api/actors")) return w.bystander;
        if (path.startsWith("/api/edges")) return g.edge;
        if (path.startsWith("/api/tags")) return g.tag;
        if (path.startsWith("/api/pointers")) return g.pointer;
        if (path.startsWith("/api/tasks")) return g.task;
        if (path.startsWith("/api/rss/sources")) return g.feed;
        if (path.startsWith("/api/rss/items")) return g.article;
        if (/\/(undelete|purge)$/.test(path)) return g.trashed;
        if (path.startsWith("/api/inbox")) return "999999999"; // a numeric id no row has
        if (path.startsWith("/api/spaces")) return g.space;
        if (path.startsWith("/api/canvases") || path.startsWith("/api/boards")) return g.canvas;
        if (path.startsWith("/api/nodes")) return g.note;
        // agent sessions, MCP sessions, backup restore jobs: no object of ours
        return ZERO_UUID;
      case "nodeId": return g.note;
      case "tagId": case "sourceId": return g.tag;
      case "actorId": case "actor_id": return w.bystander;
      case "event_id": case "root_event_id": return g.event;
      case "viewId": return path.startsWith("/api/tags") ? g.tagView : g.noteView;
      case "tokenId": return w.bystanderToken;
      case "versionId": case "eventId": case "job": return ZERO_UUID;
      // An agent run no one has: answers 404 to everyone. The per-note write check on a
      // real run (viewer skipped, outsider 404) is historyActivity.integration.test.ts.
      case "runId": return `legacy:${ZERO_UUID}:1`;
      // A rewind no one made: 404 to everyone (historyRewind.integration.test.ts covers a real one).
      case "rewindId": return ZERO_UUID;
      case "key": return "wpmattr"; // the attribute every group's note carries
      case "blockId": return ZERO_UUID;
      // An anchor no one has: nothing to confirm for anyone (the permission check comes first).
      case "anchorId": return "wpmnone";
      case "toolName": return "nosuchtool";
      case "kind": return "nosuchkind";
      case "decision": return "approve";
      case "action": return "retry";
      case "functionId": return "skills";
      default:
        throw new Error(
          `writePermissionMatrix: no substitution for :${name} in ${path} — a new parameterized write route appeared; extend fillPath() deliberately`,
        );
    }
  });
}

// ── Bodies ─────────────────────────────────────────────────────────────────
type Body = Record<string, unknown> | FormData | undefined;
type BodyFill = (g: Group, w: World) => Body;
const none: BodyFill = () => undefined;
const json = (fn: (g: Group, w: World) => Record<string, unknown>): BodyFill => fn;

const edit = json(() => ({ markdown: `wpm-edit-${STAMP}` }));
const rename = json(() => ({ name: `wpm-renamed-${STAMP}` }));
const titled = json(() => ({ title: `wpm-retitled-${STAMP}` }));

/** The minimal valid body of every write route, by "METHOD path". A route
 *  missing here fails the suite. Bodies aim at the group they are given. */
const BODY_FILL: Record<string, BodyFill> = {
  "DELETE /api/actors/:id": none,
  "DELETE /api/actors/:id/tokens/:tokenId": none,
  "DELETE /api/backup/restore/:id": none,
  "DELETE /api/canvases/:id": none,
  "DELETE /api/edges/:id": none,
  "DELETE /api/external-calendars/:id": none,
  "DELETE /api/nodes/:id": none,
  "DELETE /api/nodes/:id/attributes/:key": none,
  "DELETE /api/nodes/:id/tags/:tagId": none,
  "DELETE /api/nodes/:id/views/:viewId": none,
  "DELETE /api/pointers/:id": none,
  "DELETE /api/review/cards/:nodeId": none,
  "PUT /api/review/cards/:nodeId": none,
  "DELETE /api/review/settings/:tagId": none,
  "DELETE /api/rss/mutes/:id": none,
  "DELETE /api/spaces/:id": none,
  "DELETE /api/spaces/:id/members/:actorId": none,
  "DELETE /api/tags/:tagId/views/:viewId": none,
  "PATCH /api/actors/:id": rename,
  "PATCH /api/actors/:id/tokens/:tokenId": json(() => ({ access: "read" })),
  "PATCH /api/boards/:id": titled,
  "PATCH /api/canvases/:id": titled,
  "PATCH /api/nodes/:id": edit,
  "PATCH /api/nodes/:id/views/:viewId": rename,
  "PATCH /api/external-calendars/:id": json(() => ({ name: "wpm" })),
  "PATCH /api/review/settings/:tagId": json(() => ({})),
  "PATCH /api/rss/sources/:id": json(() => ({ always_fulltext: true, save_default: { tag_ids: [], parent_id: null } })),
  "PATCH /api/spaces/:id": rename,
  "PATCH /api/tags/:id": rename,
  "PATCH /api/tags/:id/modules": json(() => ({ skills: true })),
  "PUT /api/tags/:id/functions/:functionId": json(() => ({})),
  "DELETE /api/tags/:id/functions/:functionId": json(() => ({})),
  "PATCH /api/tags/:id/functions/:functionId": json(() => ({ config: {} })),
  "PATCH /api/tags/:id/schema": json(() => ({ fields: [] })),
  "PATCH /api/tags/:tagId/views/:viewId": rename,
  "PATCH /api/tasks/:id": json(() => ({ status: "done" })),
  "POST /api/tasks": json((g) => ({ title: "wpm", space_id: g.space })),
  "POST /api/external-calendars": json(() => ({ name: "wpm", color: "#3b82f6", url: "https://example.invalid/wpm.ics" })),
  "POST /api/external-calendars/:id/refresh": none,
  "POST /api/tasks/focus": json(() => ({})),
  "POST /api/push/subscriptions": json(() => ({ endpoint: "https://fcm.googleapis.com/fcm/send/wpm", p256dh: "wpm", auth: "wpm" })),
  "DELETE /api/push/subscriptions": json(() => ({ endpoint: "https://fcm.googleapis.com/fcm/send/wpm" })),
  "POST /api/tasks/focus/:id/end": json(() => ({})),
  "PATCH /api/tasks/focus/:id": json(() => ({ note: "wpm" })),
  "POST /api/tasks/:id/place": json((g) => ({ note_id: g.note })),
  "POST /api/tasks/:id/unplace": none,
  "PATCH /api/workspace": rename,
  "PATCH /api/workspace/config": json(() => ({})),
  "PATCH /api/workspace/modules": json(() => ({ module: "review", imported: false })),
  "PATCH /api/workspace/time": json(() => ({ time_zone: "Pacific/Kiritimati", day_start_hour: 6 })),
  "POST /api/actors": json(() => ({ name: `wpm-new-${STAMP}`, type: "human" })),
  "POST /api/actors/:id/invite": json(() => ({ email: `wpm-${STAMP}@matrix.test` })),
  "POST /api/actors/:id/tokens": json(() => ({ name: "wpm-token", access: "read" })),
  "POST /api/actors/:id/tokens/:tokenId/revoke": none,
  "POST /api/ai/credentials": json(() => ({ label: "wpm", api_key: "wpmwpmwpmwpmwpmwpmwpmwpm", base_url: "http://127.0.0.1:9", protocol: "v1_messages" })),
  "POST /api/ai/credentials/test": json(() => ({ base_url: "http://127.0.0.1:9", api_key: "wpmwpmwpmwpmwpmwpmwpmwpm", protocol: "v1_messages" })),
  "POST /api/ai/credentials/:id/test": none,
  "POST /api/ai/roles": json(() => ({ name: "wpm", connection: { kind: "mcp" } })),
  "DELETE /api/ai/credentials/:id": none,
  "PUT /api/ai/roles/:actor_id/runtime": json(() => ({ default_runtime: "mcp" })),
  "PATCH /api/ai/roles/:actor_id": json(() => ({ review_rule: "suggest" })),
  "POST /api/ai/selection-actions": json((g) => ({ agent_actor_id: randomUUID(), node_id: g.note, skill: "fix", text: "wpm", request_id: randomUUID() })),
  "POST /api/ai/panel-chat": json((g) => ({ agent_actor_id: randomUUID(), node_id: g.note, text: "wpm", request_id: randomUUID() })),
  "DELETE /api/ai/panel-chat/:nodeId": none,
  "POST /api/agent-sessions": json((g) => ({ node_id: g.note, block_text: "@wpm hello" })),
  "POST /api/agent-sessions/:id/cancel": none,
  "POST /api/agent-sessions/:id/revert": none,
  "POST /api/agent-sessions/:id/insert-reply": none,
  "POST /api/ai-suggestions/:id/accept": json(() => ({ item_ids: "all" })),
  "POST /api/ai-suggestions/:id/reject": json(() => ({ item_ids: "all" })),
  "POST /api/agent-sessions/runners/:actor_id/enabled": json(() => ({ enabled: true })),
  "POST /api/backup/restore/:id/apply": json((g) => ({ space_id: g.space, mode: "merge" })),
  "POST /api/backup/restore/upload": none,
  "POST /api/fresh-proof": json(() => ({ purpose: "snapshot_export", evidence: { kind: "acknowledgement" } })),
  "POST /api/snapshot": none,
  "POST /api/bookmark": json((g) => ({ url: "https://example.invalid/", space_id: g.space })),
  "POST /api/bookmark/preview": json(() => ({ url: "https://example.invalid/" })),
  "POST /api/capture/inbox": json(() => ({})),
  "POST /api/canvases": json((g) => ({ title: `wpm-canvas-${STAMP}`, space_id: g.space })),
  "POST /api/edges": json((g) => ({ source_node_id: g.note, target_node_id: g.linked, edge_type: "wpm_edge" })),
  "POST /api/events/:event_id/restore": none,
  "POST /api/events/:event_id/revert-conflict": none,
  "POST /api/import/obsidian": json(() => ({ files: [{ path: `wpm-${STAMP}.md`, content: "wpm" }] })),
  "POST /api/history/deleted/purge": json((g) => ({ items: [{ node_id: g.note, expected_ids: [g.note] }] })),
  "POST /api/history/rewind": json((g) => ({ t: new Date(0).toISOString(), restore_ids: [g.note], undelete_ids: [], delete_ids: [g.note] })),
  "POST /api/history/rewinds/:rewindId/undo": json((g) => ({ node_ids: [g.note] })),
  "POST /api/history/agent-runs/:runId/redo": json((g) => ({ node_ids: [g.note] })),
  "POST /api/history/agent-runs/:runId/undo": json((g) => ({ node_ids: [g.note] })),
  "POST /api/inbox/:event_id/:decision{approve|reject}": none,
  "POST /api/inbox/approvals/:id/:decision{approve|reject}": none,
  "POST /api/inbox/batch": json((g) => ({ decision: "approve", event_ids: [g.event] })),
  "POST /api/inbox/failed-effects/:id/retry": none,
  "POST /api/inbox/failed-effects/kinds/:kind/:action{retry|dismiss}": none,
  "POST /api/inbox/groups/:root_event_id/:decision{approve|reject}": none,
  "POST /api/invites/claim": json(() => ({ token: "nosuchtoken" })),
  "POST /api/mcp/sessions/:id/claim": none,
  "POST /api/mcp/sessions/:id/events": json(() => ({ seq: 1, kind: "ack" })),
  "POST /api/mcp/sessions/:id/finish": json(() => ({ status: "failed" })),
  "POST /api/mcp/tools/:toolName": json(() => ({})),
  "POST /api/media": none,
  "POST /api/nodes": json((g) => ({ title: `wpm-new-${STAMP}`, markdown: "x", space_id: g.space })),
  "POST /api/nodes/:id/block-to-child": json(() => ({ block_ref: "wpm-none" })),
  "POST /api/nodes/:id/block-links": json(() => ({ source_note_id: "00000000-0000-4000-8000-000000000000", at: 0, seen_text: "wpm" })),
  "POST /api/nodes/:id/block-anchors/:anchorId/confirm": json(() => ({})),
  "POST /api/nodes/:id/expand-child": json(() => ({ child_id: "00000000-0000-4000-8000-000000000000" })),
  "POST /api/nodes/:id/paragraphs/:blockId/reassign": json(() => ({ at: 0, body_hash: "0".repeat(64) })),
  "POST /api/nodes/:id/duplicate": none,
  "POST /api/nodes/:id/export-preview": json(() => ({ title: "wpm", markdown: "wpm" })),
  "POST /api/nodes/:id/promote": json(() => ({})),
  "POST /api/nodes/:id/purge": json((g) => ({ expected_ids: [g.trashed] })),
  "POST /api/nodes/:id/suggested-links": json(() => ({})),
  "POST /api/nodes/:id/tasks": json(() => ({ title: "wpm" })),
  "POST /api/nodes/:id/undelete": none,
  "POST /api/nodes/:id/versions/:versionId/restore": none,
  "POST /api/nodes/:id/ink-versions/:eventId/restore": none,
  "POST /api/nodes/:id/views": rename,
  "POST /api/pointers": json((g) => ({ target_id: g.linked, parent_id: g.note })),
  "POST /api/preview": json(() => ({})),
  "POST /api/publish": json(() => ({ preview_hash: "0".repeat(64) })), // a body the route accepts, so the check that runs is the caller's
  "POST /api/publish/include": json((g) => ({ noteIds: [g.note] })),
  "POST /api/publish/keep-off-subtree": json((g) => ({ noteId: g.note })),
  "POST /api/publish/preview": json(() => ({})),
  "POST /api/query": json(() => ({})),
  "POST /api/review/:nodeId/grade": json(() => ({ rating: 3 })),
  "POST /api/review/:nodeId/undo-grade": json(() => ({})),
  "POST /api/review/:nodeId/tomorrow": json(() => ({})),
  "POST /api/review/:nodeId/suspend": json(() => ({})),
  "POST /api/review/:nodeId/resume": json(() => ({})),
  "POST /api/review/blocks/:blockId/grade": json(() => ({ rating: 3 })),
  "POST /api/review/blocks/:blockId/undo-grade": json(() => ({})),
  "POST /api/review/blocks/:blockId/tomorrow": json(() => ({})),
  "POST /api/review/blocks/:blockId/suspend": json(() => ({})),
  "POST /api/review/blocks/:blockId/resume": json(() => ({})),
  "POST /api/rss/items/:id/fulltext": none,
  "POST /api/rss/items/:id/save": json(() => ({})),
  "POST /api/rss/items/:id/seen": none,
  "POST /api/rss/mutes": json(() => ({ keyword: "wpm-mute" })),
  "POST /api/rss/opml": json(() => ({ opml: "<opml version=\"2.0\"><body></body></opml>" })),
  "POST /api/rss/sources/:id/refresh": none,
  "POST /api/rss/sources/:id/unsubscribe": none,
  "POST /api/rss/subscribe": json(() => ({ url: "https://example.invalid/feed" })),
  "POST /api/spaces": rename,
  "POST /api/spaces/move": json((g, w) => ({ node_id: g.note, to_space_id: w.E.space, membership_epoch: w.epoch })),
  "POST /api/sync": json(() => ({})),
  "POST /api/sync/bodies": json((g) => ({ ids: [g.note] })),
  "POST /api/sync/drawings": json(() => ({})),
  "POST /api/sync/nodes": json((g) => ({ ids: [g.note] })),
  "POST /api/tags": rename,
  "POST /api/tags/:sourceId/merge": json((g) => ({ target_id: g.tag })),
  "POST /api/tags/:tagId/views": rename,
  "POST /api/tags/import": json(() => ({})),
  "POST /api/tags/resolve-path": json(() => ({ path: `wpm/${STAMP}` })),
  "POST /api/workspace/owner-transfer": json((_g, w) => ({ to_actor_id: w.bystander, confirm_name: "wpm" })),
  "PUT /api/agent-sessions/runners/:actor_id": json(() => ({ handle: "wpm" })),
  "PUT /api/me/prefs/:key": json(() => ({ value: "x" })),
  "PUT /api/nodes/:id/attributes/:key": json(() => ({ value: "wpm", value_type: "text" })),
  "PUT /api/nodes/:id/position": json(() => ({ x: 1, y: 1 })),
  "PUT /api/nodes/:id/tags/:tagId": none,
  "PUT /api/review/settings/:tagId": json(() => ({})),
  "PUT /api/rss/source-space": json((g) => ({ space_id: g.space })),
  "PUT /api/spaces/:id/members/:actorId": json(() => ({ permission: "edit" })),
  "PUT /api/tags/:id/extends": json((g) => ({ extends: [g.tag2] })),
};

// ── Allowlist ──────────────────────────────────────────────────────────────
// Routes that are legitimately public or act only on the caller's own state.
// Each entry needs a reason. `skip` = legs the route is EXCLUDED from;
// `may2xx` = legs where a 2xx is the right answer (the response is still
// scanned for R's markers and the group's rows must still be unchanged).
type Leg = "anonymous" | "viewer" | "editor" | "token";
type Allow = { reason: string; skip?: Leg[]; may2xx?: ("viewer" | "editor")[] };
const MEMBERS = ["viewer", "editor"] as const;
const ALLOW: Record<string, Allow> = {
  "POST /api/auth/*": {
    reason: "better-auth's own public endpoints (sign-in / sign-up); the handler is mocked here",
    skip: ["anonymous", "viewer", "editor", "token"],
  },
  "POST /api/invites/claim": {
    reason: "a signed-in person claims their own invite; a member who already belongs gets 409",
    may2xx: [...MEMBERS],
  },
  "PUT /api/me/prefs/:key": {
    reason: "the signed-in person's own preferences; no note, space or other member is involved",
    skip: [...MEMBERS],
  },
  "POST /api/tasks/focus": {
    reason: "begins the caller's OWN focus record (any_space_write); it names no space or note of anyone else (a task it names must be readable, judged separately)",
    may2xx: [...MEMBERS],
  },
  "POST /api/external-calendars": {
    reason: "adds a calendar to the caller's OWN list (personal, no space); the address is sealed and never answered back",
    may2xx: [...MEMBERS],
  },
  "PATCH /api/external-calendars/:id": {
    reason: "changes the caller's OWN calendar (only rows of their actor id match); names no space, note or other member",
    may2xx: [...MEMBERS],
  },
  "DELETE /api/external-calendars/:id": {
    reason: "removes the caller's OWN calendar (only rows of their actor id match); names no space, note or other member",
    may2xx: [...MEMBERS],
  },
  "POST /api/external-calendars/:id/refresh": {
    reason: "fetches the caller's OWN calendar again (only rows of their actor id match); writes nothing another member can read",
    may2xx: [...MEMBERS],
  },
  "POST /api/push/subscriptions": {
    reason: "registers the caller's OWN device for lock-screen reminders; it names no space, note or other member",
    may2xx: [...MEMBERS],
  },
  "DELETE /api/push/subscriptions": {
    reason: "removes the caller's OWN device subscription (by endpoint, scoped to the caller); names no space, note or other member",
    may2xx: [...MEMBERS],
  },
  "POST /api/capture/inbox": {
    reason: "makes the workspace's capture module tag (收件匣) on first use, as a member's first task makes #task (any_space_write); idempotent, names no space or note",
    may2xx: [...MEMBERS],
  },
  "POST /api/import/obsidian": {
    reason: "imports into the caller's OWN personal space (any_space_write); no space or note of anyone else is named",
    may2xx: [...MEMBERS],
  },
  "POST /api/history/deleted/purge": {
    reason: "per-note results: a note the caller may not purge comes back refused in `results`; nothing is removed (rows unchanged is still checked)",
    may2xx: [...MEMBERS],
  },
  "POST /api/history/rewind": {
    reason: "per-note results: notes the caller may not write come back as `unwritable`/`stale`; nothing changes (rows unchanged is still checked)",
    may2xx: [...MEMBERS],
  },
  "POST /api/bookmark/preview": {
    reason: "reads a public page's title for the caller; touches no note",
    may2xx: [...MEMBERS],
  },
  "POST /api/query": {
    reason: "POST used as a read: rows come from the caller's readable set",
    may2xx: [...MEMBERS],
  },
  "POST /api/nodes/:id/export-preview": {
    reason: "renders text the caller sends for a note they can read; writes nothing",
    may2xx: ["viewer"],
  },
  "DELETE /api/ai/panel-chat/:nodeId": {
    reason: "the caller's OWN conversation with the AI about a note they can read: hides their sessions from the panel; the note and everyone else's conversations are untouched",
    may2xx: ["viewer"],
  },
  "POST /api/rss/mutes": { reason: "the caller's own mute of feed articles (rss_mutes is per actor, like rss_seen)", may2xx: [...MEMBERS] },
  "DELETE /api/rss/mutes/:id": { reason: "ends the caller's own mute", may2xx: [...MEMBERS] },
  "DELETE /api/review/settings/:tagId": {
    reason: "the caller's own review settings for a (global) tag definition",
    may2xx: [...MEMBERS],
  },
  "PATCH /api/review/settings/:tagId": {
    reason: "the caller's own review settings for a (global) tag definition",
    may2xx: [...MEMBERS],
  },
  "PUT /api/review/settings/:tagId": {
    reason: "the caller's own review settings for a (global) tag definition",
    may2xx: [...MEMBERS],
  },
  "POST /api/review/:nodeId/resume": {
    reason: "clears the caller's OWN hold on a card they can read: personal progress, not an edit of the note (like grading)",
    may2xx: ["viewer"],
  },
  "POST /api/rss/items/:id/seen": { reason: "marks an article the caller can read as seen for the caller only (rss_seen is per actor)", may2xx: ["viewer"] },
  "POST /api/sync": { reason: "a sync pull is POST-shaped but only reads the caller's readable set", may2xx: [...MEMBERS] },
  "POST /api/sync/bodies": { reason: "a sync pull: reads the caller's readable set", may2xx: [...MEMBERS] },
  "POST /api/sync/drawings": { reason: "a sync pull: reads the caller's readable set", may2xx: [...MEMBERS] },
  "POST /api/sync/nodes": { reason: "a sync pull: reads the caller's readable set", may2xx: [...MEMBERS] },
  "POST /api/tags": {
    reason: "any member who can write somewhere (their own personal space counts) may create a tag; definitions live in no space",
    may2xx: [...MEMBERS],
  },
  "POST /api/tags/resolve-path": {
    reason: "creates a missing tag chain, the same rule as POST /api/tags",
    may2xx: [...MEMBERS],
  },
};

// ── Known gaps ─────────────────────────────────────────────────────────────
// Holes this sweep found whose fix is larger than a local authority check.
// The route still runs on these legs; the suite stays green only while the
// hole REPRODUCES (when it is fixed the test fails until the entry is deleted).
const KNOWN_GAPS: Record<string, { legs: ("viewer" | "editor")[]; comment: string }> = {
  "POST /api/rss/items/:id/save": {
    legs: ["viewer"],
    comment: "A member who may only VIEW the feed's space saves an article: the note lands in their own space (fine), but the "
      + "shared staging row is stamped saved_node_id = their note, for every reader. A per-reader saved state "
      + "(like rss_seen) is a schema change, not a local check.",
  },
};

// Routes whose handler answers before it reaches an authorization decision in
// this fixture, with the reason. A 400 / 409 / 422 from them proves nothing, so
// each is named; the sweep fails on any other route that is not refused by a
// 403 / 404.
const UNREACHED: Record<string, string> = {
  "POST /api/agent-sessions/:id/cancel": "needs a live agent session (a configured runner and a claimed token)",
  "POST /api/agent-sessions/:id/revert": "needs a finished agent session",
  "POST /api/backup/restore/:id/apply": "needs the caller's own uploaded backup zip",
  "DELETE /api/backup/restore/:id": "needs the caller's own uploaded backup zip",
  "POST /api/events/:event_id/revert-conflict": "needs a recorded attribute conflict",
  "POST /api/mcp/sessions/:id/events": "agent-token endpoint on the agent's OWN session; a person gets 404 for any id",
  "POST /api/mcp/sessions/:id/finish": "agent-token endpoint on the agent's OWN session; a person gets 404 for any id",
  "POST /api/mcp/tools/:toolName": "the agent-token tool gateway; a person's session has no tools",
  "POST /api/review/blocks/:blockId/grade": "needs a paragraph that is a review card (it holds its own review reference)",
  "POST /api/review/blocks/:blockId/undo-grade": "needs a paragraph that is a review card (it holds its own review reference)",
  "POST /api/review/blocks/:blockId/tomorrow": "needs a paragraph that is a review card (it holds its own review reference)",
  "POST /api/review/blocks/:blockId/suspend": "needs a paragraph that is a review card (it holds its own review reference)",
  "POST /api/review/blocks/:blockId/resume": "needs a paragraph that is a review card (it holds its own review reference)",
  "POST /api/review/:nodeId/tomorrow": "puts off the caller's own card; needs a note that is a review card (it holds its own review reference)",
  "POST /api/review/:nodeId/suspend": "stops the caller's own card; needs a note that is a review card (it holds its own review reference)",
  "POST /api/review/:nodeId/resume": "resumes the caller's own card; needs a note that is a review card (it holds its own review reference)",
  "POST /api/backup/restore/upload": "stages the caller's own zip (validated as a zip, no note or space named); the space-aimed step is apply",
  "POST /api/media": "multipart upload gated only by 'can write somewhere'; no note or space is named",
  "POST /api/review/:nodeId/grade": "grades the caller's own review state; needs a note that is a review card (it holds its own review reference)",
  "POST /api/review/:nodeId/undo-grade": "undoes the caller's own grade; nothing to undo before a first grade",
  "POST /api/rss/opml": "creates the caller's own subscriptions in their personal space; needs live feeds",
  "POST /api/rss/subscribe": "creates the caller's own subscription in their personal space; needs a live feed",
};

const key = (r: MountedRoute) => `${r.method} ${r.path}`;
const isMcp = (p: string) => p.startsWith("/api/mcp");

describe.skipIf(!isTestDatabase())("write permission matrix (real app, DB)", () => {
  let W: World;
  let routes: MountedRoute[] = [];
  const actors = { owner: "", viewer: "", editor: "" };
  let bearer = "";

  async function human(ws: string, label: string): Promise<{ id: string; external: string }> {
    const external = `wpm-${label}-${STAMP}`;
    const id = (await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type, external_id) VALUES ($1, $2, 'human', $3) RETURNING id::text`,
      [ws, `WPM ${label} ${STAMP}`, external])).rows[0]!.id;
    return { id, external };
  }

  async function seedGroup(ws: string, label: string, space: string, actorId: string): Promise<Group> {
    const title = `WPMTITLE${label}${STAMP}`;
    const body = `WPMBODY${label}${STAMP}`;
    const slug = `wpmslug-${label.toLowerCase()}-${STAMP}`;
    const node = async (type: string, t: string, s: string, md = ""): Promise<string> => {
      const id = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1,'manual',$2,$3,$4,$5) RETURNING id::text`, [ws, type, t, s, md])).rows[0]!.id;
      await putInSpace(id, space);
      return id;
    };
    const note = await node("content", title, slug, body);
    const linked = await node("content", `${title} linked`, `${slug}-linked`, `${body} linked`);
    const tag = await node("class_tag", `WPMTAG${label}${STAMP}`, `wpmtagslug-${label.toLowerCase()}-${STAMP}`);
    const canvas = await node("canvas", `${title} canvas`, `${slug}-canvas`);
    const edge = (await seedQ<{ id: string }>(
      `INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status)
       VALUES ($1,$2,$3,'wpm_edge','active') RETURNING id::text`, [ws, note, linked])).rows[0]!.id;
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [note, tag]);
    await seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
       VALUES ($1,$2,'wpmattr',$3,'text',false,'explicit')`, [ws, note, body]);
    const event = (await q<{ id: string }>(
      `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload)
       VALUES ($1,'user',$2,'NODE_UPDATED','node',$3,'{}') RETURNING id::text`, [ws, actorId, note])).rows[0]!.id;
    const tag2 = await node("class_tag", `WPMTAG2${label}${STAMP}`, `wpmtagslug2-${label.toLowerCase()}-${STAMP}`);
    const trashed = await node("content", `${title} trashed`, `${slug}-trashed`, `${body} trashed`);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [trashed]);
    // A subscription is a row in the group's space, not a note.
    const feed = (await seedQ<{ id: string }>(
      `INSERT INTO rss_subscriptions (workspace_id, space_id, title, url) VALUES ($1,$2,$3,'https://feed.invalid/wpm') RETURNING id::text`,
      [ws, space, `${title} feed`])).rows[0]!.id;
    const article = (await q<{ id: string }>(
      `INSERT INTO rss_staging (workspace_id, subscription_id, guid, title, url, body)
       VALUES ($1,$2,$3,$4,'https://feed.invalid/a',$5) RETURNING id::text`,
      [ws, feed, `wpm-${label}-${STAMP}`, `${title} article`, `${body} article`])).rows[0]!.id;
    const pointer = (await q<{ id: string }>(
      `INSERT INTO note_pointers (workspace_id, parent_id, target_id) VALUES ($1,$2,$3) RETURNING id::text`,
      [ws, note, linked])).rows[0]!.id;
    return { space, note, linked, tag, tag2, edge, canvas, event, trashed, feed, article, pointer, task: ZERO_UUID,
      noteView: ZERO_UUID, tagView: ZERO_UUID, title, body, slug };
  }

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const ws = await getWorkspaceId();
    const owner = await human(ws, "owner");
    const viewer = await human(ws, "viewer");
    const editor = await human(ws, "editor");
    const bystander = await human(ws, "bystander");
    await setWorkspaceOwner(ws, owner.id);
    // Every module on and every confirm-once module (RSS, semantic search, website)
    // agreed to: otherwise their routes answer 409 before the authority check runs.
    await setModulesOn(ws, null);
    actors.owner = owner.external; actors.viewer = viewer.external; actors.editor = editor.external;

    const spaceV = await makeSpace(ws, `wpm V ${STAMP}`, [{ id: owner.id, permission: "edit" }, { id: viewer.id, permission: "view" }]);
    const spaceE = await makeSpace(ws, `wpm E ${STAMP}`, [{ id: owner.id, permission: "edit" }, { id: editor.id, permission: "edit" }]);
    const spaceR = await makeSpace(ws, `wpm R ${STAMP}`, [{ id: owner.id, permission: "edit" }]);
    const bystanderToken = (await createToken(bystander.id, { name: "wpm-bystander", access: "read" })).id;
    W = {
      epoch: "0", ws, ownerId: owner.id, bystander: bystander.id, bystanderToken,
      V: await seedGroup(ws, "V", spaceV, owner.id),
      E: await seedGroup(ws, "E", spaceE, owner.id),
      R: await seedGroup(ws, "R", spaceR, owner.id),
    };

    // objects only the API can make (a task, a saved view), made as the owner
    const asOwner = async (method: string, path: string, body: unknown): Promise<{ id?: string }> => {
      sessionExternalId = owner.external;
      try {
        const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return res.status < 300 ? await res.json() as { id?: string } : {};
      } finally { sessionExternalId = null; }
    };
    for (const g of [W.V, W.E, W.R]) {
      g.task = (await asOwner("POST", `/api/nodes/${g.note}/tasks`, { title: `wpm task ${STAMP}` })).id ?? ZERO_UUID;
      g.noteView = (await asOwner("POST", `/api/nodes/${g.note}/views`, { name: `wpm view ${STAMP}` })).id ?? ZERO_UUID;
      g.tagView = (await asOwner("POST", `/api/tags/${g.tag}/views`, { name: `wpm tag view ${STAMP}` })).id ?? ZERO_UUID;
    }

    // a bearer token whose agent belongs to no space (reaches nothing)
    const agent = await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type, external_id) VALUES ($1, 'WPM Agent', 'agent', $2) RETURNING id::text`,
      [ws, `wpm-agent-${STAMP}`]);
    bearer = (await createToken(agent.rows[0]!.id, { name: "wpm-empty-scope", access: "write" })).plaintext;

    // the full-text route fetches the article's page: answer it locally
    __setPageFetchForTests(async () => `<html><body><article><p>wpm fetched ${STAMP}</p></article></body></html>`);

    routes = mountedRoutes(app, (m) => ["POST", "PUT", "PATCH", "DELETE"].includes(m));
  });

  afterAll(() => {
    __setPageFetchForTests(null);
  });

  // ── helpers ──────────────────────────────────────────────────────────────
  async function call(route: MountedRoute, g: Group, as: { session?: string; bearer?: string }): Promise<Response> {
    W.epoch = (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [W.ws])).rows[0]!.e;
    const path = fillPath(route.path, g, W);
    const body = BODY_FILL[key(route)]!(g, W);
    const headers: Record<string, string> = {};
    if (as.bearer) headers.authorization = `Bearer ${as.bearer}`;
    let init: RequestInit = { method: route.method, headers };
    if (body instanceof FormData) init = { ...init, body };
    else if (body !== undefined) init = { ...init, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) };
    sessionExternalId = as.session ?? null;
    try {
      return await app.request(path, init);
    } finally {
      sessionExternalId = null;
    }
  }

  /** Everything a refused write must leave alone, for one group's objects. */
  async function snapshot(g: Group): Promise<unknown> {
    const ids = [g.note, g.linked, g.tag, g.tag2, g.canvas, g.trashed, g.feed];
    const rows = async (sql: string, params: unknown[]) => (await q(sql, params)).rows;
    return {
      nodes: await rows(
        `SELECT id, title, slug, markdown, parent_id, space_id, deleted_at, tag_schema, hidden, node_type
           FROM content_nodes WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]),
      attributes: await rows(
        `SELECT node_id, key, value FROM node_attributes WHERE node_id = ANY($1::uuid[]) ORDER BY node_id, key`, [ids]),
      edges: await rows(
        `SELECT id, source_node_id, target_node_id, edge_type, status FROM node_edges
          WHERE source_node_id = ANY($1::uuid[]) OR target_node_id = ANY($1::uuid[]) ORDER BY id`, [ids]),
      tags: await rows(
        `SELECT node_id, tag_id FROM node_tags WHERE node_id = ANY($1::uuid[]) ORDER BY node_id, tag_id`, [ids]),
      pointers: await rows(`SELECT id, parent_id, target_id FROM note_pointers WHERE id = $1`, [g.pointer]),
      articles: await rows(`SELECT id, seen_at, saved_node_id, tombstoned_at, body FROM rss_staging WHERE id = $1`, [g.article]),
      subscriptions: await rows(
        `SELECT id, space_id, title, url, always_fulltext, default_tag_ids, default_parent_id, fetch_interval_minutes, last_error
           FROM rss_subscriptions WHERE id = $1`, [g.feed]),
      tasks: await rows(`SELECT id, deleted_at FROM content_nodes WHERE id = $1`, [g.task === ZERO_UUID ? null : g.task]),
      space: await rows(`SELECT id, name, kind, deleted_at, capabilities FROM spaces WHERE id = $1`, [g.space]),
      members: await rows(`SELECT actor_id, permission FROM space_members WHERE space_id = $1 ORDER BY actor_id`, [g.space]),
      events: (await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM domain_events WHERE target_id = ANY($1::text[])`, [[...ids, g.edge, g.space]])).rows[0]!.n,
    };
  }

  const trace = (leg: string, r: MountedRoute, res: Response, text: string): void => {
    if (process.env.WPM_TRACE) appendFileSync(process.env.WPM_TRACE, `${leg}\t${key(r)}\t${res.status}\t${text.slice(0, 300)}\n`);
  };

  /** One problem per part of the snapshot that differs. */
  function changed(route: string, before: unknown, after: unknown, group: string): string[] {
    const b = before as Record<string, unknown>;
    const a = after as Record<string, unknown>;
    return Object.keys(b).filter((part) => !isDeepStrictEqual(b[part], a[part])).map((part) => `${route} changed ${group}'s ${part}`);
  }

  /** Markers of `g` found in a response. An id the caller put in the request
   *  itself may be echoed back (a 404 naming the id asked for); any other id,
   *  and every title, body and slug, may not. */
  function leaks(text: string, g: Group, route: MountedRoute): string[] {
    const asked = `${fillPath(route.path, g, W)} ${JSON.stringify(BODY_FILL[key(route)]!(g, W) ?? "")}`;
    const ids = [g.note, g.linked, g.canvas, g.edge, g.space].filter((id) => !asked.includes(id));
    return [g.title, g.body, g.slug, ...ids].filter((needle) => text.includes(needle));
  }

  // ── the matrix ───────────────────────────────────────────────────────────
  it("introspection found a plausible inventory and every route is fillable (completeness gate)", () => {
    expect(routes.length).toBeGreaterThanOrEqual(100);
    for (const sentinel of ["POST /api/nodes", "PATCH /api/nodes/:id", "DELETE /api/nodes/:id", "POST /api/edges", "PUT /api/nodes/:id/tags/:tagId"]) {
      expect(routes.map(key), `sentinel ${sentinel} missing from inventory`).toContain(sentinel);
    }
    for (const r of routes) {
      if (ALLOW[key(r)]?.skip?.length === 4) continue;
      fillPath(r.path, W.V, W); // throws on an unknown :param
      expect(BODY_FILL[key(r)], `no BODY_FILL entry for ${key(r)} — extend the table deliberately`).toBeDefined();
    }
    const stale = Object.keys(BODY_FILL).filter((k) => !routes.some((r) => key(r) === k));
    expect(stale, "BODY_FILL entries for routes that are no longer mounted").toEqual([]);
    const staleAllow = Object.keys(ALLOW).filter((k) => !routes.some((r) => key(r) === k));
    expect(staleAllow, "ALLOW entries for routes that are no longer mounted").toEqual([]);
  });

  it("(a) anonymous → 401 on every write route", async () => {
    const problems: string[] = [];
    for (const r of routes) {
      if (ALLOW[key(r)]?.skip?.includes("anonymous")) continue;
      const res = await call(r, W.V, {});
      if (res.status !== 401) problems.push(`${key(r)} → ${res.status}`);
    }
    expect(problems).toEqual([]);
  });

  /** Statuses that show the request was REFUSED for who is asking (403) or
   *  for a note the asker cannot see (404). Anything else — a 400 for a body
   *  the route did not like, a 409 for state it did not find — means the
   *  authorization check may never have run. */
  const REFUSED = new Set([403, 404]);

  /** One member leg over every route, aimed at `g`; returns the problems. */
  async function sweepMember(leg: "viewer" | "editor", g: Group, asWhom: string): Promise<string[]> {
    const problems: string[] = [];
    for (const r of routes) {
      if (ALLOW[key(r)]?.skip?.includes(leg)) continue;
      const own: string[] = [];
      const before = await snapshot(g);
      const res = await call(r, g, { session: actors[leg] });
      const text = await res.text();
      trace(leg, r, res, text);
      const twoXxOk = ALLOW[key(r)]?.may2xx?.includes(leg) ?? false;
      if (res.status >= 200 && res.status < 300 && !twoXxOk) own.push(`${key(r)} → ${res.status} for ${asWhom}`);
      else if (res.status >= 500) own.push(`${key(r)} → ${res.status} (server error)`);
      else if (UNREACHED[key(r)] && res.status === 403) {
        own.push(`${key(r)} is listed in UNREACHED but answers 403 now: delete the entry`);
      } else if (!twoXxOk && !REFUSED.has(res.status) && !UNREACHED[key(r)]) {
        own.push(`${key(r)} → ${res.status}: refused, but not by an authorization answer (403/404) — the check may not have run; fix the body or list the route in UNREACHED`);
      }
      const found = leaks(text, W.R, r);
      if (found.length && g === W.R) own.push(`${key(r)} leaked R's markers: ${found.join(", ")}`);
      else if (found.length) own.push(`${key(r)} leaked R's markers to ${asWhom}`);
      own.push(...changed(key(r), before, await snapshot(g), g === W.R ? "R" : "V"));
      const gap = KNOWN_GAPS[key(r)];
      if (gap?.legs.includes(leg)) {
        if (own.length === 0) problems.push(`${key(r)} no longer reproduces its KNOWN_GAPS entry for ${leg}: delete the entry`);
      } else problems.push(...own);
    }
    return problems;
  }

  it("(b) view-only member aimed at V: never 2xx, V unchanged", async () => {
    expect(await sweepMember("viewer", W.V, "a view-only member")).toEqual([]);
  }, 30_000);

  it("(c) member with no access to R: never 2xx, R unchanged, no R markers in the response", async () => {
    expect(await sweepMember("editor", W.R, "a member with no access to R")).toEqual([]);
  }, 30_000);

  it("(d) bearer token with an agent in no space → 403 token_scope outside /api/mcp/*", async () => {
    const problems: string[] = [];
    for (const r of routes) {
      if (ALLOW[key(r)]?.skip?.includes("token")) continue;
      const res = await call(r, W.V, { bearer });
      const text = await res.text();
      if (isMcp(r.path)) {
        if (res.status >= 500) problems.push(`${key(r)} → ${res.status} (server error)`);
      } else if (res.status !== 403 || !text.includes("token_scope")) {
        problems.push(`${key(r)} → ${res.status}, want 403 token_scope`);
      }
      if (leaks(text, W.R, r).length) problems.push(`${key(r)} leaked R's markers to a token`);
    }
    expect(problems).toEqual([]);
  });

  // ── regression cases for what the sweep found ──────────────────────────────
  const asSession = async (external: string, method: string, path: string, body?: unknown): Promise<Response> => {
    sessionExternalId = external;
    try {
      return await app.request(path, {
        method, headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } finally { sessionExternalId = null; }
  };

  it("regression: refreshing a feed edits its feed state, so a view-only member is refused and files no fetch", async () => {
    const queued = async (feed: string) => (await q(`SELECT 1 FROM outbox WHERE dedup_key = $1`, [`rss_fetch:${feed}`])).rowCount;
    const before = await queued(W.V.feed);
    const refused = await asSession(actors.viewer, "POST", `/api/rss/sources/${W.V.feed}/refresh`);
    expect(refused.status).toBe(403);
    expect(await queued(W.V.feed)).toBe(before);
    // the same call by someone who may edit the feed's space still works
    const ok = await asSession(actors.editor, "POST", `/api/rss/sources/${W.E.feed}/refresh`);
    expect(ok.status).toBe(200);
  });

  it("regression: a subscription is a row in a space: settings and unsubscribe need the edit permission there, and outsiders do not see it", async () => {
    const row = async (id: string) => (await q(`SELECT always_fulltext, default_tag_ids FROM rss_subscriptions WHERE id = $1`, [id])).rows;
    const settings = { always_fulltext: true, save_default: { tag_ids: [], parent_id: null } };
    // View-only on V: seen, not changed.
    const viewerPatch = await asSession(actors.viewer, "PATCH", `/api/rss/sources/${W.V.feed}`, settings);
    expect(viewerPatch.status).toBe(403);
    const viewerLeave = await asSession(actors.viewer, "POST", `/api/rss/sources/${W.V.feed}/unsubscribe`);
    expect(viewerLeave.status).toBe(403);
    expect(await row(W.V.feed)).toEqual([{ always_fulltext: false, default_tag_ids: null }]);
    // No access to R: the subscription does not exist for them.
    for (const [method, path, body] of [
      ["PATCH", `/api/rss/sources/${W.R.feed}`, settings],
      ["POST", `/api/rss/sources/${W.R.feed}/unsubscribe`, undefined],
      ["POST", `/api/rss/sources/${W.R.feed}/refresh`, undefined],
    ] as const) {
      const res = await asSession(actors.editor, method, path, body);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain(W.R.feed);
    }
    expect(await row(W.R.feed)).toEqual([{ always_fulltext: false, default_tag_ids: null }]);
    const list = await asSession(actors.editor, "GET", "/api/rss/sources");
    const ids = ((await list.json()) as { sources: Array<{ id: string }> }).sources.map((x) => x.id);
    expect(ids).toContain(W.E.feed);
    expect(ids).not.toContain(W.R.feed);
    // The editor of E may change its settings.
    const ok = await asSession(actors.editor, "PATCH", `/api/rss/sources/${W.E.feed}`, settings);
    expect(ok.status).toBe(200);
    expect(await row(W.E.feed)).toEqual([{ always_fulltext: true, default_tag_ids: [] }]);
  });

  it("regression: loading an article's full text rewrites the shared body, so a view-only member is refused", async () => {
    // a fresh, unsaved article of its own (the sweep may have saved the shared fixture)
    const article = async (g: Group) => (await q<{ id: string }>(
      `INSERT INTO rss_staging (workspace_id, subscription_id, guid, title, url, body)
       VALUES ($1,$2,$3,'wpm fulltext','https://feed.invalid/ft','original') RETURNING id::text`,
      [W.ws, g.feed, `wpm-ft-${randomUUID()}`])).rows[0]!.id;
    const bodyOf = async (id: string) => (await q<{ body: string }>(`SELECT body FROM rss_staging WHERE id = $1`, [id])).rows[0]!.body;
    const inV = await article(W.V);
    const refused = await asSession(actors.viewer, "POST", `/api/rss/items/${inV}/fulltext`);
    expect(refused.status).toBe(403);
    expect(await bodyOf(inV)).toBe("original");
    const inE = await article(W.E);
    const ok = await asSession(actors.editor, "POST", `/api/rss/items/${inE}/fulltext`);
    expect(ok.status).toBe(200);
    expect(await bodyOf(inE)).toContain("wpm fetched");
  });

  it("regression: a refusal names no note the caller did not ask about", async () => {
    // the editor names an EDGE and an EVENT of R; the refusal must not answer with R's note id
    for (const [method, path] of [["DELETE", `/api/edges/${W.R.edge}`], ["POST", `/api/events/${W.R.event}/restore`]] as const) {
      const res = await asSession(actors.editor, method, path);
      expect([403, 404], path).toContain(res.status);
      expect(await res.text(), path).not.toContain(W.R.note);
    }
  });

  // ── sanity: the matrix cannot pass by everything failing for a wrong reason ──
  it("sanity: the editor CAN edit E's note", async () => {
    const res = await app.request(`/api/nodes/${W.E.note}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown: `${W.E.body} by editor` }),
    }); // no session yet: must be refused
    expect(res.status).toBe(401);
    sessionExternalId = actors.editor;
    try {
      const ok = await app.request(`/api/nodes/${W.E.note}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown: `${W.E.body} by editor` }),
      });
      expect(ok.status).toBe(200);
    } finally { sessionExternalId = null; }
    expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [W.E.note])).rows[0]!.markdown)
      .toBe(`${W.E.body} by editor`);
  });

  it("sanity: the owner CAN edit R's note (R is owner-only, not frozen)", async () => {
    sessionExternalId = actors.owner;
    try {
      const ok = await app.request(`/api/nodes/${W.R.note}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown: `${W.R.body} by owner` }),
      });
      expect(ok.status).toBe(200);
    } finally { sessionExternalId = null; }
    expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [W.R.note])).rows[0]!.markdown)
      .toBe(`${W.R.body} by owner`);
    // and the same note stays out of the other member's reach
    sessionExternalId = actors.editor;
    try {
      const denied = await app.request(`/api/nodes/${W.R.note}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown: "intrusion" }),
      });
      expect([403, 404]).toContain(denied.status);
    } finally { sessionExternalId = null; }
  });
});
