// Onden backend custom rule: require-read-gate
//
// The read-side counterpart of the spine's write gate. A WRITE goes through
// mutate(); a READ that fetches content_nodes rows and SERVES them to an actor
// must consult the read policy. The Critical leak this guards (audit #1/#2): a
// site that SELECTs from content_nodes and ships it without a read-policy check
// lets any authenticated actor — a low-role human, or a tag-scoped agent — read
// nodes they shouldn't.
//
// BY-CONSTRUCTION FLIP (2026-06-27): this rule used to watch only `routes/*.ts`
// GET handlers and only check a file *mentioned* a primitive — services,
// agentTools and modules that read content_nodes were entirely outside its view,
// and a file could reference a primitive on one read while leaking on another.
// It now covers the WHOLE backend src tree: every file that reads content_nodes
// (FROM/JOIN — writes go through the spine, not here) must be classified into
// exactly one bucket. A new, UNCLASSIFIED reader is a lint error — it cannot
// silently ship an ungated read. This is the "forbidden unless reviewed" default
// that makes the read gate by-construction rather than by-discipline.
//
//   GATED    — serves node data; routes through a read-policy primitive
//              (canReadNode for single nodes; readableScopeSql / readableNodeIdSet
//              / visibleNodeIdsForActor for lists; restrictRowsToScope; a mandatory
//              `readableIds` scope param; or a scoped `listItems(..., actor)` call).
//              The value is the primitive the file MUST reference — asserted, so a
//              file can't be listed then quietly drop it.
//   INTERNAL — the read is NOT served to an actor: a write-path existence/id
//              lookup, the read-policy CTEs themselves, restore inverse-ops,
//              prune/GC, dispatcher authority checks, attribute/template/tag
//              resolution. Each carries the reason it's exempt.
//   DEFERRED — the public/published surface: node set is opt-in filtered
//              (publishedNodeIds), not per-actor scoped.
//
// Keys are paths RELATIVE TO src/ (basenames collide).

import { usesGate } from "./gateEvidence.js";

// relative path → primitive regex the file MUST reference (serving reads)
const GATED = {
  "services/panelChat.ts": /readableScopeSql/, // the info panel's AI chat: the added notes' titles and the sources it names are read through the reader's scope in SQL (and canReadNode before anything is served)
  "services/aiSuggestions.ts": /canReadNode/, // the suggestions of a note are served only after canReadNode; notes are read under the event lock after write_node for deciding/filing, never served
  "modules/importers/shared/identity.ts": /readableScopeSql/, // source list scoped in SQL; identity lookups stay inside import writes
  "services/harness/noteSkills.ts": /readableScopeSql/, // #技能 catalogue: read scope in SQL, then external_ai filter
  "modules/website/publishing/queryBlocks.ts": /readableScopeSql/, // D113 frozen query results: the evaluating actor's read scope in SQL, rows only from the listed (published) pages
  "modules/website/publishing/excerptEmbeds.ts": /readableScopeSql/, // 2026-10-29 excerpt embeds: source notes read as the publishing actor (SQL scope); only the excerpt paragraph is copied out
  "services/sync/bootstrap.ts": /readableNodeIdSet/,     // /api/bootstrap payload
  "services/nodeReads.ts": /canReadNode/,                 // per-node GETs (ink versions, history, export row, node row, attributes): each checks canReadNode and answers null when unreadable
  "services/history/recentVersions.ts": /readableNotesSql/, // /recent feed, combined read set pushed into SQL before LIMIT
  "services/history/activity.ts": /readableNotesSql/,    // History: edit counts, a day's notes and agent runs, deleted list; read scope in SQL (deleted: readableTrashedNodeIds)
  "services/history/systemTidies.ts": /readableAmong/,   // 「系統整理」: the passes between two instants, each listing only the notes the actor can read (readableAmong)
  "services/history/agentRuns.ts": /readableNotesSql/,   // agent runs: only notes the actor can read are kept, and the run's times come from those notes' events
  "services/history/pointInTime.ts": /readableNotesSql/, // the notes at an instant: candidates are the caller's readable notes (live: readableScopeSql, deleted: readableTrashedNodeIds); events only of those
  "services/history/rewind.ts": /readableNotesSql/,       // rewind cards and undo: events shown/acted on only for notes the caller can read; writes go through updateNode/trashNode/undeleteNode
  "services/sync/delta.ts": /readableNodeIdSet/,         // sync delta: node/attr/task/edge/pointer upserts and the revocation diff scoped
  "services/sync/membership.ts": /readableNodeIdSet/,    // membership id stream and /sync/nodes projection scoped
  "services/sync/bodies.ts": /readableNodeIdSet/,        // offline body download scoped
  "services/sync/drawings.ts": /readableNodeIdSet/,      // offline drawing download (index + values) scoped
  "services/exportZip.ts": /readableNodeIdSet|readableScopeSql/, // markdown.zip scoped (push-down)
  "services/exportLeftOut.ts": /readableScopeSql/, // counts only: live rows by the read rule, trash by the space rule
  "services/standaloneTasks.ts": /readableScopeSql/, // the task list of the markdown export: scoped (push-down)
  "services/backupRestore.ts": /spaceScopeSql/, // restore preview: which backup ids are taken and readable, scope in SQL; the titles it lists come from the backup
  "services/backupArchive.ts": /vaultIndex/, // full backup: rows from exportZip vaultIndex (read scope pushed down); tag paths read global tag definitions
  "services/nodeQuery.ts": /readableScopeSql/,            // /api/query results pushed down
  "services/tagReads.ts": /canSeeTag/,                   // one tag's definition and delete preview: canSeeTag first, member lists and counts bounded by the read scope
  "services/tagViews.ts": /readableNodeIdSet|canSeeTag/, // saved views: rows bounded by the readable set; view config via canSeeTag
  "services/noteViews.ts": /readableNodeIdSet|canReadNode/, // a note's saved views: rows bounded by the readable set; the note via canReadNode
  "services/tagMerge.ts": /readableScopeSql|canSeeTag/,  // merge preview counts readable members; both tags via canSeeTag
  "services/tagPacks.ts": /canSeeTag/,                   // pack export of a tag the caller can see (install reads are write-path)
  "services/tagCatalog.ts": /spaceScopeSql\(/,           // tag definitions are global; member counts follow the space read rule
  "services/legacyTagFunctionWrites.ts": /canSeeTag\(/,   // current principal gate, then visible-tag check before any change
  "services/functionRefs.ts": /canSeeTag\(/,             // functionsOf gates each tag; functionIndex serves global tag definitions to callers that gate what they return
  "services/dayLens.ts": /readableNodeIdSet|readableScopeSql/, // day-lens buckets follow node visibility
  "services/eventQuery.ts": /readableNodeIdSet/,          // unreadable event targets redacted
  "services/canvasReads.ts": /readableScopeSql|canReadNode/, // list scoped in SQL; per-canvas read gated
  "modules/rss/itemList.ts": /readableSourceIds/,         // reading list and seen sweeps bounded by the readable source ids in SQL
  "services/boardStore.ts": /readableScopeSql/,  // board cards and graph positions filtered to readable notes
  "services/readPolicy.ts": /readableScopeSql/,  // readableAmong: the live readable subset of given ids, filtered by the read rule itself
  "services/blockRefLookup.ts": /readableScopeSql/,       // [[A#^id]] fallback: the named note and every candidate are cut by the caller's read scope in SQL
  "services/blockLinks.ts": /canReadNode[\s\S]*readableScopeSql/, // 段落連結: the target is read only after canReadNode (a hidden note answers like a missing one); the link count is cut by the reader's scope in SQL
  "services/blockCitations.ts": /readableScopeSql/,        // 被引用 N 次: the asked note and every citing note are cut by the caller's read scope in SQL
  "modules/rss/items.ts": /canReadSource/,                // gateItem: one staging item, gated through its source
  "modules/rss/sources.ts": /readableSpaceScopeSql/,      // listSources / getSource: the served source list scoped in SQL by the space rule; findSource is the internal by-id / per-space lookup (D53)
  "modules/rss/subscriptions.ts": /listSources\(/,          // subscription list, OPML export and unseen counts bounded by listSources' read scope (D53)
  "modules/rss/destination.ts": /readableScopeSql/,       // saveDefaults: a default's parent is kept only when readableScopeSql lets the reader see it; tag and destination checks answer ids only
  "modules/rss/links.ts": /listSources\(/,                // answerArticleLink: an article held at the link's address is looked for only in the reader's listSources
  "modules/rss/sourceSpace.ts": /readableSpaceScopeSql/,   // planMove: the owner moves only subscriptions readableSpaceScopeSql lets them see; the setting read and space checks answer ids only
  "modules/review/service.ts": /readableScopeSql/,        // cards and decks pushed through the read scope; grade/state gated by canReadNode (D22; moved from routes.ts)
  "services/harness/scope.ts": /readableNodeIdSet/,       // AI harness gathering bounded by caller read set
  "services/nodeSearch.ts": /readableScopeSql/,           // search results pushed down
  "services/agentSessionMemory.ts": /readableScopeSql/,    // titles of a session's note and targets only when readable
  "services/tasksStore.ts": /visibleNodeIds/, // a store, not an entry point: the served read (taskRowsForBootstrap) takes the caller's already-scoped visibleNodeIds as a mandatory parameter and filters in SQL; the id lookups serve nothing. (Was /readableNodeIdSet|visibleNodeIdsForActor/, which only a comment satisfied.)
  "services/collectionViewQuery.ts": /readableIds/,       // mandatory readable-id scope param (n.id = ANY)
  "services/agentTools/getNode.ts": /readableNote/,   // agent single-node read: through the one gated lookup below (its tag join only follows a note already read)
  "services/agentTools/getAttachment.ts": /readableScopeSql/, // agent attachment read: note scope in the query, then the media owner rule
  "services/agentTools/queryView.ts": /executeTagView\(/, // agent view query: finds the holder tag id only, then the app's own view function (rows bounded by the readable set there)
};

// relative path → documented reason the FROM/JOIN content_nodes is NOT a served,
// actor-facing read (so it's exempt from a read-policy primitive).
const INTERNAL = {
  "browser/makeOldCopy.ts": "test tool: makes the saved copy an older app would have left (and takes migration 200 back out of it); runs once offline with no actor, serves nothing",
  "services/selectionDelivery.ts": "write path: reads the note body only to splice the model's text into the proposal it hands to createSuggestions, which asserts write_node for the agent under the event lock; nothing is served",
  "services/aiSessionStart.ts": "write path: reads the note's space under the event lock AFTER the spine asserted the sender\'s authority (write_node for a selection, read for an info-panel question); only the space id is read, nothing is served",
  "services/agentSessions.ts": "write path: reads the note under the event lock AFTER the spine asserted write_node for the sender (start) or the agent (reply); the text is parsed for a mention or spliced, never served",
  "services/backupRestoreUndo.ts": "undo check of a backup restore: counts its created notes still live, after the space-manager check; serves a number",
  "services/nodeTree.ts": "subtree/ancestor id walks (D25); returns ids only, every caller gates or authorizes what it does with them",
  "services/pointers.ts": "write path (D101): reads the pointer target's node_type under the event lock to apply the placement rule (assertParentKind); answers allowed/refused, serves nothing",
  "services/parentKind.ts": "write-path check of a new parent's node_type (T12); answers only allowed/refused, never serves the row",
  "modules/website/index.ts": "library.inUse: an existence probe at the first library run (boot backfill); answers yes/no, serves no node data",
  "modules/daily/index.ts": "library.inUse: an existence probe at the first library run (boot backfill); answers yes/no, serves no node data",
  "services/viewModules.ts": "tag definitions: a tag's module marker, read to refuse applying or merging a view module tag until those tag nodes are removed; serves no node data",
  "services/workspaceModules.ts": "write path: finds or creates the module tag inside the principal-admin import transaction; returns only its id",
  "modules/importers/notion/database.ts": "write path: attachBody reads the item it just created (title, body before the write) to record the inverse patch and run the body pipeline under write_node; serves nothing",
  "services/mediaOwners.ts": "the media rule's reference lookup: which note ids reference a file (oldest first); returns ids only, and every caller decides with canReadNode (mediaAccess) or the published set (publishing/servedSite)",
  "services/nodeUpdate.ts": "edit operation; current state is read under the event lock and node authority, parent references use canPlaceUnder (read + write)",
  "services/sync/rows.ts": "edge/pointer row helpers for the sync channels; delta.ts and membership.ts filter every row by readableNodeIdSet before serving",
  "services/canvasNodes.ts": "write path: reads back the canvas row it just updated under write_node authority (routes/canvases.ts checked it exists)",
  "modules/tasks/update.ts": "task PATCH: locks the task row under the event lock; read and write authority are asserted before the row is returned (moved from routes/tasks.ts, D13)",
  "services/nodePlacement.ts": "placement rule: a parent existence probe under the event lock, followed by canReadNode and write_node authority; no node content is served",
  "services/tagFields.ts": "tag resolution: loadTagFieldRows reads every live class tag's fields/extends to compute effective (inherited) fields; tag definitions are global, and callers serve fields only for tags they already resolved",
  "services/nodeRowProjection.ts": "SQL fragments only (tag-id and attribute subqueries keyed on a row the caller already gated); callers are bootstrap, sync and GET /nodes/:id, each gated in its own file",
  "services/noteCreate.ts": "create write path; a dry run probes that each requested tag is a live definition under the event lock before the tag-apply authority; serves no node content",
  "services/noteDuplicate.ts": "atomic copy write path; source, parent and direct tags are authorized under the event lock before content is returned",
  "spine/taskIdentity.ts": "SQL identity/scope subject used inside read and write authority; executes no query and serves no content",
  "spine/reservedNodes.ts": "authority lookup: whether a node/tag is the reserved workspace-config pair; returns a boolean to assertAuthority, serves no node data",
  "spine/spaceScope.ts": "the space read rule itself (spaceScopeSql) and id-set/boolean lookups for readPolicy and the spine; serves no node content",
  "services/spaces.ts": "space read rule + shadow comparison: returns id sets and counts for the owner-only shadow report (sample ids only), serves no node content",
  "services/dispatcherQueue.ts": "fetches a node body to dispatch automation; internal queue worker",
  "modules/rss/fetch.ts": "background feed-fetch/retention worker; reads sources + staging to poll/age them, not served",
  "modules/rss/save.ts": "write path: saving an article after gateItem's read gate; reads the source's tags and the article's existing note under the event lock, serves only the saved note's id",
  "modules/rss/sourcePrefix.ts": "reads the article URLs of source ids the caller already gated (subscriptionList's listSources, links.ts after gateItem) to work out each source's prefix; serves only that prefix",
  "modules/rss/staging.ts": "write path: marks staging items seen (a shared-seen space check joins the source note) and links saves; the routes gate each item first, nothing is served",
  "services/eventRestore/tags.ts": "inverse state and preview lookup; restoreEvent/previewRestore assert the tag operation admin gate before invoking",
  "services/eventRestore/restore.ts": "restore inverse-ops; the route asserts authority before calling",
  "services/nodes.ts": "write-path helpers (slug collision / body fetch for an edit)",
  "services/wikilinkEdges.ts": "write path: derives wikilink edges from note text inside the writing transaction; returns the matched target ids/titles to the saving caller only",
  "services/nodeTrash.ts": "write path: the note and its subtree to trash, restore or purge, after delete/write/space-manager authority; the purge preview names the deleted notes only to a manager of their space who can read them",
  "services/purgedContent.ts": "purge internals: what a purged note holds elsewhere (media references, other notes still using a file), read under purgeDeleted's authority; counts only reach the caller",
  "services/nodePromote.ts": "write path: existence probe before promote; the returned row is the node just un-hidden under write_node authority",
  "services/tagIdentity.ts": "write path: the tag row locked for a rename/recolor under principal_admin; returns only the tag's own identity",
  "services/tagWrites.ts": "write path: the stored behaviour a tag_schema write replaces, to judge only the hooks it changes; not served",
  "services/nodeAttributes.ts": "attribute projection keyed by a node_id the caller already gated",
  "services/templateExpander.ts": "template-child resolution on the write path",
  "services/tagHierarchy.ts": "tag-tree ancestor/descendant traversal (vocabulary infra)",
  "services/blockChildNote.ts": "write path: reads the note under the event lock after write_node, and the notes whose links it rewrites (each rewritten only after write_node on it; their text is spliced, never served); a note is named in a refusal only after canReadNode, the rest are counted",
  "services/blockNodes.ts": "save path: tag names in a note's {…} → class_tag ids; served block rows are only for notes the caller already read-filtered",
  "services/blockMarkerRepair.ts": "system job: reads hidden block nodes and their note body to put a split marker back; serves nothing to an actor",
  "modules/tasks/blockTasks.ts": "save path (B4): the note's own line-made task nodes, read to keep them in step with its task lines inside the note's write; serves nothing",
  "modules/tasks/lines.ts": "write path (B4): the note body of a task's line, read under the task update's lock to tick its box through updateNode; serves nothing",
  "services/tagMembershipWrites.ts": "shared tag membership write operation; target/tag existence reads and both-side authority are checked under the event lock, no node content is served",
  "modules/tasks/scheduler.ts": "scheduled-task lookup by the leader daemon, not served",
  "modules/tasks/create.ts": "task create: checks the host is live and an explicit id is free or already a task the caller can read (canReadNode) under the event lock; serves nothing",
  "modules/tasks/focus.ts": "focus end: reads the task body under the event lock only to give updateNode its merge baseline; updateNode asserts write_node before it saves, a refusal is caught and nothing is served",
  "services/dayNotes.ts": "write path: finds the actor's own day note in their personal space under the event lock and appends to it through updateNode (write_node asserted there); answers whether it wrote, serves nothing",
  "modules/tasks/placement.ts": "place/unplace: reads the task, its note and its line under the event lock after canReadNode / canPlaceUnder / assertAuthority; the row it returns is the task the caller just wrote",
  "services/schemaValidation.ts": "schema lookup to validate a write, not served",
  "services/attributeChange.ts": "retypeGoverned reads the affected notes' tags to retype their stored values (D94); a write path, not served",
  "services/canvasMemberships.ts": "both endpoints (member node AND canvas) filtered to the caller-supplied visible-node set (MB2)",
  "services/embeddings.ts": "embedding bookkeeping over the outbox, not served",
  "services/outbox.ts": "asset-reference lookup for effect reconciliation, not served",
  "services/reservedTags.ts": "reserved-tag id lookup/adoption by role key (task, subscription, workspace-config, page); returns ids only, serves no node content",
  "services/siteConfig.ts": "site-config node lookup (publish settings), not node content",
};

// relative path → documented reason it reads content_nodes for the PUBLIC site,
// where the node set is opt-in filtered (publishedNodeIds), not actor-scoped.
const DEFERRED = {
  "modules/website/publishing/servedSite.ts": "serves the public site; node set opt-in filtered at build + serve",
  "modules/website/publishing/snapshot.ts": "builds the publish snapshot from publishedNodeIds (opt-in set)",
  "modules/website/publishing/frozenDesign.ts": "freezes the home page and tag pages for the snapshot: every row is a published note (ANY of the published ids), the saved view runs as the publisher narrowed to them; tag names are shown tags only",
  "modules/website/publishing/publishedSet.ts": "the published node set (opt-in ∩ publicly readable) and the marked-but-left-out list; bounded by the read policy",
  "modules/website/publishing/redaction.ts": "redacts an already-publish-scoped payload; not a fresh read",
  "modules/website/publishing/siteHome.ts": "picks the site home among ids already in the published set; returns ids only",
};

// Readers that use the typed builder (`db.selectFrom("content_nodes")`), which `readsNodes` below does not see: the
// agent tools that serve node data through it. Each must reference the read-policy primitive it claims (checked
// by the lint and by readGuard.test.ts, so a file cannot be listed and then quietly drop it). Widening
// `readsNodes` to every Kysely reader would classify dozens of older files; add a file here when it serves notes.
const TYPED_GATED = {
  "services/agentTools/readableNote.ts": /readableAmong/,   // the lookup by id or slug: read access decides before a row is picked
  "services/agentTools/listChildren.ts": /readableAmong/,   // children of a readable note/space, ids re-checked before they leave
  "services/agentTools/listSuggestions.ts": /readableAmong/,   // suggestions only of a note the caller can read
};

// A READ is FROM/JOIN content_nodes — or rss_staging / rss_subscriptions: a
// subscription is a row of a space (readable under the space rule), and a
// staging row is a restricted subscription's article content (readable iff its
// subscription is), so an ungated read of either is the same leak. Writes (INSERT INTO / UPDATE / DELETE)
// go through the spine write gate, not this rule — so they don't count here.
function readsNodes(src) {
  return /\b(from|join)\s+(public\.)?(content_nodes|rss_staging|rss_subscriptions)\b/i.test(src);
}

// ── domain_events ─────────────────────────────────────────────────────────
// An event row carries titles, body hashes and diffs, so reading the event log
// is a read surface too. Every file that reads domain_events (FROM/JOIN) is
// classified here, separately from the node buckets above: a file can gate its
// node reads and still leak events. A RegExp is the event-visibility primitive
// the file MUST reference (services/eventVisibility.ts, or the node read gate
// when every event is joined to a node it scopes); a string is the reason the
// read is not served to an actor as event data.
const EVENT_READS = {
  "services/history/systemTidies.ts": "lists the system tidy passes between two instants (the saves a pass wrote); each pass keeps only the notes the actor can read (readableAmong), titles only",
  "services/agentSessionGuard.ts": "counts the agent writes in one session's own chain against a limit; serves a number",
  "services/agentSessions.ts": "reply-only check: existence probe over the session's own chain; serves nothing",
  "services/backupRestoreUndo.ts": "undo check of a backup restore: counts its NODE_CREATED descendants still live; serves a number, never the rows",
  "services/patchedValue.ts": "finds a text kept for ONE note by hash, only among that note's own events, to rebuild a writer's patch base; serves nothing but the writer's own merge input",
  "services/eventChain.ts": "triggered_by chain ids only (D25); callers read the rows and apply event visibility",
  "services/nodeReads.ts": /canReadNode/,                      // one note's ink-version and history events: served only after canReadNode on that note
  "services/eventQuery.ts": /eventVisibleSql/,                 // /api/events: rule pushed into SQL before LIMIT
  "services/inboxQueue.ts": /eventVisibleSql/,                 // governance queue: rule in SQL before the 500 cap
  "services/sync/bootstrap.ts": /eventVisibleSql/,             // bootstrap's recent events; node meta only for returned (readable) nodes
  "services/sync/delta.ts": /readableNodeIdSet/,               // delta: events only drive upserts/deletes of readable targets; cursor is MAX(id)
  "services/sync/membership.ts": "membership version: MAX(id) of the log as a read guard; no event row is served",
  "services/dayLens.ts": /readableScopeSql/,                   // day lens: events joined to content_nodes under the read scope; serves node ids/titles
  "services/history/activity.ts": /readableNotesSql/,          // History: edits joined to content_nodes under the read scope in SQL
  "services/history/agentRuns.ts": /readableNotesSql/,         // agent events grouped into runs, then cut to notes under the read scope; only those notes' events are served
  "services/history/pointInTime.ts": /readableNotesSql/,       // a note's title/body at T: only for notes in the caller's read scope (candidate set in SQL)
  "services/history/rewind.ts": /readableNotesSql/,             // rewind events: cards and undo only for notes the caller can read
  "services/history/bodyEvents.ts": "SQL fragments and the blob lookup for body-changing events; every caller (activity, agentRuns, pointInTime, rewind, noteVersions) scopes the notes itself; serves no event row",
  "services/history/agentRunUndo.ts": "undo/redo markers: the action of this run's latest undo per note id, looked up only for notes of a run already cut to the caller's read scope; no event row is served",
  "services/history/recentVersions.ts": /readableNotesSql/,    // /recent: events joined to content_nodes under the read scope before LIMIT
  "services/history/inkChanges.ts": /canReadNode/,             // a note's handwriting edits and drawings: canReadNode before any event query; the day lists take notes activity.ts already cut to the read scope
  "services/history/noteVersions.ts": /canReadNode/,           // one note's versions: canReadNode before any event query (unreadable = null)
  "services/backupHistory.ts": "the backup of the caller's own readable notes: note ids come from vaultIndex (read scope pushed down in SQL), the versions are written to the caller's own archive; the size count is over the same ids and serves numbers",
  "spine/importedHistory.ts": "dedupe probe over the target note's own already-carried versions (tx_meta.history_import); serves nothing",
  "services/actors.ts": "owner-only actor stats: counts by type and tool, no payload or target served",
  "db.ts": "maintenance DELETE of old events; nothing is served",
  "services/dispatcherQueue.ts": "dispatcher drains its own pending events; internal",
  "services/eventRestore/restore.ts": "restore reads the event it inverts, after the restore authority check",
  "services/maintenance/prune.ts": "orphan-blob GC: which blob hashes events still reference; internal",
  "services/eventReview.ts": "reviewability probe (agent-authored, target readable via canReadRetainedNode) before a decision; no event data served",
  "modules/importers/shared/identity.ts": "EXISTS probe matching a node's creation event during import; returns node ids already read-scoped",
  "services/harness/noteSkills.ts": "EXISTS probe: was the note created by this actor (only their own notes are skills); serves no event data",
  "modules/website/publishing/snapshot.ts": "MAX(id) cursor for the publish snapshot; no event data",
  "services/tagPacks.ts": "EXISTS probe for an install event inside the owner-only pack install",
  "services/nodeUpdate.ts": "version restore reads the version it restores (an event of that note) only after the note's write_node authority under the event lock; the body becomes the note's own",
  "services/nodeTrash.ts": "undelete finds the subtree trashed by the same delete event (triggered_by); ids only, nothing served",
  "services/purgedContent.ts": "a purge reads its notes' events for the blobs they reference and erases them; no event data served",
  "services/attributeWrites.ts": /canReadNode/,               // conflict revert reads its ATTRIBUTE_CONFLICT only for a note the actor can read
};

function readsEvents(src) {
  return /\b(from|join)\s+(public\.)?domain_events\b/i.test(src);
}

// Shared with readGuard.test.ts (the vitest backstop) so the lint and the test
// classify from ONE source of truth and can't drift apart.
export const READ_GATE = { GATED, INTERNAL, DEFERRED, TYPED_GATED, readsNodes, EVENT_READS, readsEvents, usesGate };

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Files that read content_nodes (FROM/JOIN) and serve it must consult the read policy, or be classified INTERNAL/DEFERRED with a reason.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    // Only backend src, excluding tests. Key by path relative to .../src/.
    const m = /[\\/]backend[\\/]src[\\/](.+\.ts)$/.exec(filename.replace(/\\/g, "/"));
    if (!m) return {};
    const rel = m[1];
    if (rel.endsWith(".test.ts") || rel.startsWith("test/")) return {};
    return {
      "Program:exit"(node) {
        const src = (context.sourceCode || context.getSourceCode()).getText();
        if (readsEvents(src)) {
          const rule = EVENT_READS[rel];
          if (rule === undefined) {
            context.report({
              node,
              message:
                `${rel} reads domain_events (FROM/JOIN) but is unclassified. Event rows carry titles and diffs: ` +
                `scope them with eventVisibleSql (services/eventVisibility.ts) and add the file to EVENT_READS, ` +
                `or add it there with the reason the read is not served. See eslint-rules/require-read-gate.js.`,
            });
          } else if (rule instanceof RegExp && !usesGate(src, rule)) {
            context.report({ node, message: `${rel} is listed in EVENT_READS but no longer uses ${rule} (a call or a use; an import or a comment is not enough).` });
          }
        }
        const typed = TYPED_GATED[rel];
        if (typed && !usesGate(src, typed)) {
          context.report({ node, message: `${rel} is listed in TYPED_GATED but no longer uses ${typed} (a call or a use; an import or a comment is not enough) — the read gate is claimed but missing.` });
        }
        if (!readsNodes(src)) return;
        const gated = GATED[rel];
        if (gated) {
          if (!usesGate(src, gated)) {
            context.report({
              node,
              message: `${rel} is listed GATED but no longer uses ${gated} — the read gate is claimed but missing (an import or a comment is not enough: call it).`,
            });
          }
          return;
        }
        if (INTERNAL[rel] || DEFERRED[rel]) return;
        context.report({
          node,
          message:
            `${rel} reads content_nodes (FROM/JOIN) but is unclassified. If it SERVES node data, gate it ` +
            `(canReadNode / readableScopeSql / readableNodeIdSet) and add it to GATED; if the read is a ` +
            `write-path/internal lookup, add it to INTERNAL with a reason; public-site reads go in DEFERRED. ` +
            `See eslint-rules/require-read-gate.js.`,
        });
      },
    };
  },
};
