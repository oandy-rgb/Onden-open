// The sync delta (POST/GET /api/sync, depth audit D8): what changed since an
// event cursor, bounded by the actor's CURRENT read set, plus the revocation
// and grant diff against the ids the client says it holds (`known`). Moved
// verbatim from routes/sync.ts; the route only parses and responds.
//
// The security rule lives here: readableNodeIdSet is the ONLY input to both
// the upsert filter and the revocation diff (see the comment in the body).

import { anchorRowsForNotes } from "../blockAnchors/index.js";
import { bindingRowsForNotes } from "../blockLinks.js";
import { isUuid } from "@onden/markdown";
import { q } from "../../db.js";
import { db } from "../../dbKysely.js";
import type { ActorCtx } from "../../types.js";
import { readableNodeIdSet, readableTrashedNodeIds, restrictRowsToScope } from "../readPolicy.js";
import { taskNodeIdsAmong, taskRowReadable, taskRowsByIds, notATaskNodeSql } from "../tasksStore.js";
import { withActorReadSnapshot } from "../actorReadSnapshot.js";
import { readTagCatalog } from "../tagCatalog.js";
import type { CanvasMembership, ServerNode } from "@onden/contract";
import { nodeRowColumnsSql, nodeEventMetaJoinSql } from "../nodeRowProjection.js";
import { workspaceWireRow } from "../workspaceModules.js";
import { attributeColumnsSql, edgeColumnsSql, workspaceColumnsSql } from "../syncProjection.js";
import { edgeRowsTouching, pointerRowsTouching, readablePointer } from "./rows.js";
import { canvasMembershipsTouching } from "../canvasMemberships.js";
import { isWorkspaceOwner } from "../../spine/authority.js";
import { readSiteSettings } from "./bootstrap.js";
import type { AttributeDelta, NodeEdge, SyncDelta, Workspace } from "@onden/contract";
import { liveNodeSql, tagNodeSql } from "../../spine/nodeSql.js";
import type { RespacedGroup } from "../orderKeys.js";

// Bound the POST payload so a client can't ask the server to diff an unbounded
// id list. The native app holds at most the workspace's node count; 50k is a
// generous ceiling that still caps a hostile request. EXCEEDING it is handled
// FAIL-CLOSED (resync_required below), never by silent truncation: a truncated
// `known` would drop the over-limit ids out of BOTH the revocation diff (stale
// copies linger) AND the grant diff, silently. Better to make the client
// re-bootstrap (complete + read-policy-filtered) than to leak.
export const MAX_KNOWN_IDS = 50_000;

/** The delta after event `since` for `authenticated` (re-read in this read
 *  snapshot), with the membership diff against `known` — the ids the client
 *  holds; [] (GET, and the routine client) means event-driven only. A `known`
 *  above MAX_KNOWN_IDS answers resync_required instead of truncating. */
export async function buildSyncDelta(
  authenticated: ActorCtx | null,
  workspaceId: string,
  { since, known }: { since: number; known: string[] },
): Promise<SyncDelta> {
  // FAIL-CLOSED (not silent truncation): a held set larger than the cap can't be
  // diffed completely, and silently dropping the overflow would leave revocations
  // unpropagated (stale copies) and grants unsynced. Tell the client to drop its
  // mirror and re-bootstrap — the bootstrap is read-policy-filtered and complete,
  // so it re-establishes a correct membership baseline. (Electric's must-refetch
  // / 409 shape-rotation is the same fail-closed escape hatch.)
  if (known.length > MAX_KNOWN_IDS) {
    return withActorReadSnapshot(authenticated, workspaceId, async () => {
      const maxIdRes = await q(
        `SELECT COALESCE(MAX(id), 0) AS max_id FROM domain_events WHERE workspace_id = $1`,
        [workspaceId],
      );
      const resync: SyncDelta = {
        resync_required: true,
        last_event_id: maxIdRes.rows[0].max_id as number,
        head_event_id: String(maxIdRes.rows[0].max_id),
        nodes: { upsert: [], delete: [] },
        edges: { upsert: [], delete: [] },
        tasks: { upsert: [], delete: [] },
        attributes: { upsert: [], delete: [] },
        workspace: null,
      };
      return resync;
    });
  }
  return withActorReadSnapshot(authenticated, workspaceId, async (actor) => {
    // Audit #1: the delta is bounded by the COMBINED read set (role/tag-policy
    // visibility ∩ bearer-token tag scope) — token scope alone let a low-role
    // human sync full rows of policy-restricted nodes.
    //
    // HIGH gap #2 (revocation): `readableNodeIdSet` is the SINGLE source of truth
    // for readability — it is the ONLY permitted input for BOTH the positive
    // upsert filter (restrictRowsToScope below) AND the negative revocation diff
    // (known.filter(id => !readableSet.has(id)) below). Never branch on event
    // types to decide a node left the read set: a permission change (tag policy
    // tightened, role downgrade, token scope narrowed, reparent under a
    // restricted ancestor) emits NO node-targeted event, so an event-type branch
    // would miss it and leave a stale local copy forever. Diffing the client's
    // held ids against this set is fail-closed and mechanism-agnostic: any future
    // readability rule propagates as a delete automatically.
    const readableSet = await readableNodeIdSet(actor, workspaceId);

    const eventsRes = await q(
      // payload included so ATTRIBUTE_SET / ATTRIBUTE_DELETED can identify the key.
      `SELECT id, event_type, target_type, target_id, payload
       FROM domain_events
       WHERE workspace_id = $1 AND id > $2
       ORDER BY id ASC
       LIMIT 500`,
      [workspaceId, since],
    );

    // The membership epoch (membership-and-permission-epoch.md): exposed on every
    // sync response so the client can detect "the readable set may have changed"
    // and run a reconciliation only then. Step A surfaces it; Step B gates the
    // reconciliation on it.
    const epochRes = await q(
      `SELECT membership_epoch,
              COALESCE((SELECT MAX(id) FROM domain_events WHERE workspace_id = $1), 0)::text AS head_event_id
         FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    const membershipEpoch = Number(epochRes.rows[0]?.membership_epoch ?? 0);
    const headEventId = String(epochRes.rows[0]?.head_event_id ?? 0);

    const knownSet = new Set(known);

    // NEGATIVE membership diff (revocation) — held ids no longer readable → delete.
    // Computed from the CURRENT read set, independent of the event window: a
    // permission change emits no node event, so only a set diff catches it.
    // Each scope unites its tag grants before intersecting with the other scope
    // and role policy. Losing one matching tag need not revoke the node.
    const revoked = known.filter((id) => !readableSet.has(id));

    // POSITIVE membership diff (grants) — the symmetric twin of `revoked`. When a
    // permission WIDENS (role promotion, policy relaxed, token scope expanded) NO
    // node event fires either, so the newly-readable nodes the client doesn't yet
    // hold would never arrive. We diff the CURRENT read set against the client's
    // declared held set: readable − known = nodes to upsert. Only in CVR mode
    // (known non-empty): a client asserting "this is everything I have". GET
    // callers pass [] and keep the legacy event-only behaviour (no full-set dump).
    const granted = known.length > 0
      ? [...readableSet].filter((id) => !knownSet.has(id))
      : [];

    // Acknowledge only events this page actually scanned. A later MAX(id) read
    // could see a concurrent commit absent from an empty page and skip it forever.
    const lastEventId = eventsRes.rows.length > 0
      ? (eventsRes.rows[eventsRes.rows.length - 1].id as number)
      : since;

    const nodeUpsert = new Set<string>();
    const nodeDelete = new Set<string>();
    const edgeUpsert = new Set<string>();
    const edgeDelete = new Set<string>();
    const taskUpsert = new Set<string>();
    const taskDelete = new Set<string>();
    // Attribute keys identified as (nodeId, key) since the table has no surrogate.
    const attrUpsert = new Set<string>();   // serialised as `${nodeId}:${key}`
    const attrDelete = new Set<string>();
    const tagTargets = new Set<string>();
    let workspaceChanged = false;
    let siteSettingsChanged = false;
    const purges: Array<{ spaceId: string; at: number; nodes: string[]; tasks: string[] }> = [];
    // Sibling groups whose keys were all rewritten by one write (services/orderKeys.ts respaceIfTooLong).
    const respacedGroups: RespacedGroup[] = [];
    // The id of the last event in this page that brings an id back (created,
    // updated, undeleted…). A purge earlier in the page must not delete what
    // a later event recreated with the same id — a backup restore does that
    // (services/backupRestore.ts): events are applied in their order.
    const revivedAt = new Map<string, number>();

    for (const ev of eventsRes.rows) {
      const type = ev.event_type as string;
      const id = ev.target_id as string;
      // A canvas IS a node (migration 057): CANVAS_CREATED / CANVAS_UPDATED
      // (a rename, or a card placed / moved / taken off the board) target it
      // as 'canvas' and re-ship its row like any node event (D98).
      const targetsNode = ev.target_type === "node" || ev.target_type === "canvas";
      if (type !== "NODES_PURGED" && type !== "NODE_DELETED" && type !== "NODE_PURGED" && type !== "TASK_DELETED"
        && (targetsNode || type.startsWith("TASK_"))) {
        revivedAt.set(id, Number(ev.id));
      }
      if (ev.target_type === "tag") tagTargets.add(id);
      // NODE_HIDDEN_CHANGED is emitted by the dispatcher (not by routes/nodes.ts),
      // so it needs to trigger a node-row refresh on the client. NODE_UNDELETED is
      // what BOTH the undelete route AND restore-of-a-NODE_DELETED emit — without
      // it here a delete→restore left the node stuck in the client's delete channel
      // forever (no convergence; the row only came back on a full re-bootstrap).
      if (["NODE_CREATED", "NODE_UPDATED", "NODE_RESTORED", "NODE_UNDELETED", "NODE_PROMOTED", "NODE_HIDDEN_CHANGED"].includes(type)
        // An anchor confirmed or created on its own changes nothing else of the note, but its anchors ship with it.
        || type.startsWith("BLOCK_ANCHOR_")) {
        nodeUpsert.add(id); nodeDelete.delete(id);
        const group = (ev.payload as { order_respaced?: Partial<RespacedGroup> } | null)?.order_respaced;
        if (group && (group.table === "content_nodes" || group.table === "note_pointers")
          && (group.parent_id === null || (typeof group.parent_id === "string" && isUuid(group.parent_id)))) {
          respacedGroups.push({ table: group.table, parent_id: group.parent_id });
        }
      } else if (type === "NODE_DELETED" || type === "NODE_PURGED") {
        // NODE_PURGED is the hard, unrecoverable removal (prune). It must reach the
        // client as a delete too — otherwise a purged node lingered locally forever
        // (the row is gone server-side, so only a delete signal can clear it).
        nodeDelete.add(id); nodeUpsert.delete(id);
      } else if (["EDGE_CREATED"].includes(type)) {
        edgeUpsert.add(id); edgeDelete.delete(id);
      } else if (type === "EDGE_DELETED") {
        edgeDelete.add(id); edgeUpsert.delete(id);
      } else if (["TASK_CREATED", "TASK_UPDATED", "TASK_OCCURRENCE_MISSED"].includes(type)) {
        // Legacy pre-062 event types (task ids survive the migration verbatim) +
        // the scheduler's missed-occurrence event, whose target IS a task node.
        taskUpsert.add(id);
      } else if (type === "TASK_DELETED") {
        taskDelete.add(id); taskUpsert.delete(id);
      } else if (type === "WORKSPACE_UPDATED" || type === "WORKSPACE_TIME_ZONE_CHANGED" || type === "MODULE_IMPORTED" || type === "MODULE_REMOVED") {
        // Importing or removing a module changes workspaces.modules.
        workspaceChanged = true;
      } else if (type === "SITE_CONFIG_UPDATED") {
        // The site settings or the Studio's design (workspaceSettings.ts):
        // re-shipped whole below, as the bootstrap ships them.
        siteSettingsChanged = true;
      } else if (type === "NODES_PURGED") {
        // Notes deleted for good (services/nodeTrash.ts purgeDeleted). Their
        // rows are gone, so neither the read set nor the trash can say who
        // held them: the event names them, on the space they were in.
        const payload = ev.payload as { node_ids?: unknown; task_ids?: unknown } | null;
        purges.push({ spaceId: id, at: Number(ev.id), nodes: idList(payload?.node_ids), tasks: idList(payload?.task_ids) });
      } else if (type === "ATTRIBUTE_SET") {
        const payload = ev.payload as { key?: string } | null;
        const key = payload?.key;
        if (key) {
          const composite = `${id}:${key}`;
          attrUpsert.add(composite); attrDelete.delete(composite);
        }
      } else if (type === "ATTRIBUTE_DELETED") {
        const payload = ev.payload as { key?: string } | null;
        const key = payload?.key;
        if (key) {
          const composite = `${id}:${key}`;
          attrDelete.add(composite); attrUpsert.delete(composite);
        }
      } else if (targetsNode) {
        // STRUCTURAL SAFETY NET: any OTHER event whose target is a content node
        // (current or future) re-ships that node, so its projection can never
        // silently go stale — the class of bug TAG_APPLIED / TAG_REMOVED were
        // (a tag change altering class_tag_ids/label_tag_ids with no sync channel).
        // Re-shipping is idempotent and the re-fetch below is read-filtered, so this
        // is conservative, not leaky. The explicit branches above still handle the
        // deletes + the non-node channels (edge/task/attribute) precisely; this only
        // catches node-targeting types they don't name. New node events therefore
        // converge by default instead of needing a hand-edit to this switch.
        // It never cancels a delete earlier in this page: a late audit event on
        // a deleted note (DISPATCHER_FAILED from a cascade that lost the race
        // with the delete) would leave the deleted note on the device for good.
        // Only the lifecycle events above bring a note back.
        if (!nodeDelete.has(id)) nodeUpsert.add(id);
      }
    }

    // A respace rewrote the keys of rows its event does not name: ship the whole live group, so every copy ends with the
    // server's keys. For pointers the group is shipped with its parent (pointer rows travel with the notes they sit under).
    for (const group of respacedGroups) {
      if (group.table === "note_pointers") {
        if (group.parent_id !== null) { nodeUpsert.add(group.parent_id); nodeDelete.delete(group.parent_id); }
        continue;
      }
      const siblings = await db.selectFrom("content_nodes").select("id").where("workspace_id", "=", workspaceId)
        .where("deleted_at", "is", null).where("parent_id", group.parent_id === null ? "is" : "=", group.parent_id).execute();
      for (const { id } of siblings) if (!nodeDelete.has(id)) nodeUpsert.add(id);
    }

    // A tag is a node and its schema determines every direct member's tag
    // classification. Refresh both projections for tag-targeted changes and
    // ordinary node lifecycle events (trash/undelete/restore of a tag). The
    // read snapshot and existing channel filters remain the authority gate.
    // Epoch changes alone only reconcile visibility, not an already-held row.
    const possibleTags = [...new Set([...tagTargets, ...nodeUpsert, ...nodeDelete])];
    let tagCatalogChanged = tagTargets.size > 0;
    if (possibleTags.length) {
      const tags = await q<{ id: string; deleted_at: string | null }>(
        `SELECT id, deleted_at FROM content_nodes WHERE workspace_id=$1
          AND id=ANY($2::uuid[]) AND ${tagNodeSql()}`, [workspaceId, possibleTags.filter(isUuid)],
      );
      tagCatalogChanged ||= tags.rows.length > 0;
      for (const tag of tags.rows) {
        if (tag.deleted_at) { nodeDelete.add(tag.id); nodeUpsert.delete(tag.id); }
        else { nodeUpsert.add(tag.id); nodeDelete.delete(tag.id); }
      }
      for (const id of tagTargets) {
        if (!tags.rows.some((tag) => tag.id === id)) { nodeDelete.add(id); nodeUpsert.delete(id); }
      }
      if (tags.rows.length) {
        const members = await q<{ node_id: string }>(
          `SELECT DISTINCT nt.node_id FROM node_tags nt
            JOIN content_nodes n ON n.id=nt.node_id
            WHERE n.workspace_id=$1 AND nt.tag_id=ANY($2::uuid[]) AND ${liveNodeSql("n")}`,
          [workspaceId, tags.rows.map((tag) => tag.id)],
        );
        for (const { node_id: id } of members.rows) { nodeUpsert.add(id); nodeDelete.delete(id); }
      }
    }

    // Fold the POSITIVE diff into the upsert set: newly-readable nodes the client
    // doesn't hold are fetched + shipped exactly like event-window upserts (same
    // read-filter, same task-reroute, same row shape below). They're already in
    // `readableSet` (readable by construction), so restrictRowsToScope keeps them.
    for (const id of granted) { nodeUpsert.add(id); nodeDelete.delete(id); }

    // Tasks are NODES (migration 062), but the delta keeps the frozen wire shape:
    // task-node churn travels in `tasks` (synthesized rows), never in `nodes` /
    // `attributes` — otherwise hidden task nodes would pollute every client's
    // node list. Classify which touched targets are task nodes and reroute them.
    const taskish = new Set<string>([...nodeUpsert, ...nodeDelete]);
    for (const token of [...attrUpsert, ...attrDelete]) {
      const idx = token.indexOf(":");
      if (token.slice(idx + 1).startsWith("_task_")) taskish.add(token.slice(0, idx));
    }
    const taskNodeIds = await taskNodeIdsAmong(workspaceId, [...taskish]);
    for (const id of taskNodeIds) {
      if (nodeUpsert.delete(id)) taskUpsert.add(id);
      if (nodeDelete.delete(id)) { taskDelete.add(id); taskUpsert.delete(id); }
      for (const token of [...attrUpsert]) {
        if (token.startsWith(`${id}:`)) { attrUpsert.delete(token); if (!taskDelete.has(id)) taskUpsert.add(id); }
      }
      for (const token of [...attrDelete]) {
        if (token.startsWith(`${id}:`)) { attrDelete.delete(token); if (!taskDelete.has(id)) taskUpsert.add(id); }
      }
    }

    // Resolve attribute upserts. Composite "<nodeId>:<key>" tokens are split
    // into parallel node_ids[] + keys[] arrays so a single WHERE-IN query
    // re-fetches the snapshot's rows. Keys deleted later in the history visible
    // to this snapshot are absent from the upsert result.
    const attrUpsertList = [...attrUpsert].map((token) => {
      const idx = token.indexOf(":");
      return { node_id: token.slice(0, idx), key: token.slice(idx + 1) };
    });
    const attrDeleteList = [...attrDelete].map((token) => {
      const idx = token.indexOf(":");
      return { node_id: token.slice(0, idx), key: token.slice(idx + 1) };
    });

    // One snapshot client: await each channel before starting the next query.
    // Node shape is the bootstrap's (nodeRowProjection) — the client swaps
    // these rows into its store as they are.
    const nodesRes = nodeUpsert.size > 0
      ? await q<ServerNode>(
          `SELECT ${nodeRowColumnsSql("n")}
           FROM content_nodes n
           ${nodeEventMetaJoinSql("n")}
           WHERE n.workspace_id=$1 AND n.id=ANY($2) AND ${liveNodeSql("n")}`,
          [workspaceId, [...nodeUpsert]],
        )
      : { rows: [] };
    // Both endpoints must be ALIVE: edge rows survive a node trash in the
    // substrate (recoverable by undelete), but a delta that ships them would
    // leak the trashed node's existence back onto a read surface.
    const edgesRes = edgeUpsert.size > 0
      ? await q<NodeEdge>(
          `SELECT ${edgeColumnsSql("e")} FROM node_edges e
           JOIN content_nodes s ON s.id = e.source_node_id AND ${liveNodeSql("s")} AND ${notATaskNodeSql("s")}
           JOIN content_nodes t ON t.id = e.target_node_id AND ${liveNodeSql("t")} AND ${notATaskNodeSql("t")}
           WHERE e.workspace_id=$1 AND e.id=ANY($2)`,
          [workspaceId, [...edgeUpsert]],
        )
      : { rows: [] };
    // Wikilink, incoming-wikilink and semantic edges are derived from node bodies
    // and change without EDGE_* events. Every non-task node shipped below also
    // ships ALL live edges touching it, and `replace_for` tells the client that
    // this set is complete: local edges touching those nodes and absent here are
    // stale (a removed link, a now-unreadable endpoint, a pre-fix churned id).
    const edgeScope = nodesRes.rows.map((r) => r.id as string);
    const touchingRes = { rows: edgeScope.length > 0 ? await edgeRowsTouching(workspaceId, edgeScope) : [] };
    const shippedEdges = new Map<string, NodeEdge>();
    for (const row of [...edgesRes.rows, ...touchingRes.rows]) {
      if (!edgeDelete.has(row.id)) shippedEdges.set(row.id, row);
    }
    // Sidebar pointers have no channel of their own: POINTER_CREATED/DELETED
    // target the pointed-to node, which the safety net above re-ships. Ship
    // every pointer placed under or pointing at a shipped node, with the same
    // live/non-task endpoint rules as the bootstrap, and let `replace_for`
    // retire local pointers that are absent here.
    const pointersRes = edgeScope.length > 0 ? await pointerRowsTouching(workspaceId, edgeScope) : [];
    // Synthesized task rows (the frozen node_tasks shape) from task nodes.
    const tasksRes = { rows: await taskRowsByIds(workspaceId, [...taskUpsert]) };
    const wsRes = workspaceChanged
      ? await q<Workspace & { modules_off: unknown; modules_confirmed: unknown }>(`SELECT ${workspaceColumnsSql("w")} FROM workspaces w WHERE w.id = $1`, [workspaceId])
      : { rows: [] };
    // The reader's view of the settings (the owner's tokens only to the
    // owner), read in this snapshot like the rows; nothing without a config
    // note yet.
    const siteSettings = siteSettingsChanged
      ? await readSiteSettings(workspaceId)
      : null;
    const attrsRes = attrUpsertList.length > 0
      ? await q<AttributeDelta>(
          // Pair-match (node_id, key) by passing the touched pairs as a single
          // JSONB array. PG's jsonb_to_recordset expands it to a typed tuple
          // set we join against. Avoids node-postgres's text[]/uuid[]
          // serialization quirks.
          `SELECT ${attributeColumnsSql("na")}
           FROM node_attributes na
           JOIN jsonb_to_recordset($2::jsonb) AS pair(node_id uuid, key text)
             ON na.node_id = pair.node_id AND na.key = pair.key
           -- attr rows survive a node trash (substrate); the delta must not
           -- ship a trashed node's attributes back onto a read surface
           JOIN content_nodes n ON n.id = na.node_id AND ${liveNodeSql("n")}
           WHERE na.workspace_id = $1`,
          [workspaceId, JSON.stringify(attrUpsertList)],
        )
      : { rows: [] };

    // Drop anything outside the actor's read set from the content-bearing
    // upserts — node rows, their attributes, their tasks, and edges (both ends
    // must be readable, else the actor learns an out-of-scope node exists).
    // Deletes are filtered below (couldHold).
    const nodesUpsert = restrictRowsToScope(nodesRes.rows, (r) => r.id as string, readableSet);
    const attrsUpsert = restrictRowsToScope(attrsRes.rows, (r) => r.node_id as string, readableSet);
    // Tasks are scoped by BOTH ends, like edges and like the bootstrap query
    // (taskRowsForBootstrap): the task node's OWN id (read policy applies to
    // tasks themselves — 062's payoff; host TAG restrictions cascade onto it
    // via parent_id) AND the host id the synthesized row carries as `node_id`
    // — a host outside the read set (e.g. out of a bearer token's tag scope)
    // must not have its id leak through its task rows. Pre-062 sync scoped by
    // node_id alone; the tasks-as-nodes rewrite scoped by task id alone; the
    // composition-laws merge showed each half is leaky without the other.
    const tasksUpsert = tasksRes.rows.filter((r) => taskRowReadable(readableSet, r));
    const edgesUpsert = [...shippedEdges.values()].filter(
      (r) => readableSet.has(r.source_node_id as string) && readableSet.has(r.target_node_id as string),
    );
    // Only nodes that survived the read filter certify their edge/pointer sets.
    const edgeReplaceFor = nodesUpsert.map((r) => r.id as string);
    const pointersUpsert = pointersRes.filter((r) => readablePointer(r, readableSet));
    // The boards each shipped node is on, and the notes on each shipped canvas.
    const membershipsUpsert = await canvasMembershipsTouching(workspaceId, edgeReplaceFor, readableSet);

    // Fold the revocation diff into the delete channels. `revoked` is, BY
    // CONSTRUCTION, the held ids NOT in `readableSet` (not currently readable), so a
    // revoked id can NEVER be in the read-policy-filtered upserts above — it must
    // ALWAYS be deleted from the client. (A concurrently RE-GRANTED node is
    // readable → in readableSet → excluded from `revoked` already.) ROUTE BY TYPE: a
    // revoked TASK node goes to tasks.delete (the client deletes tasks by their OWN
    // id there); a host-only cascade / nodes.delete-by-id missed it, so a revoked
    // task lingered locally. Non-task revoked → nodes.delete. (The previous
    // unconditional nodeDelete also predates this task-channel split.)
    const revokedTaskIds = revoked.length
      ? new Set(await taskNodeIdsAmong(workspaceId, revoked))
      : new Set<string>();
    for (const id of revoked) {
      if (revokedTaskIds.has(id)) { taskDelete.add(id); taskUpsert.delete(id); }
      else { nodeDelete.add(id); }
      nodeUpsert.delete(id);
    }
    // Deleted for good: a delete for each id, to whoever could have held it —
    // a member of the space it was in, or the owner for a shared space (the
    // rule eventVisibility applies to the NODES_PURGED event itself). Ids
    // only; the rows are gone, so nothing is re-fetched.
    const purgedForReader = new Set<string>();
    // Only when this reader can see the revived note: one recreated in a
    // space they are not in still leaves them the purge's delete.
    const laterRevived = (id: string, at: number) => (revivedAt.get(id) ?? -1) > at && readableSet.has(id);
    for (const purge of purges.length > 0 ? await purgesReadableBy(actor, workspaceId, purges) : []) {
      for (const nodeId of purge.nodes) {
        if (laterRevived(nodeId, purge.at)) continue;
        nodeDelete.add(nodeId); nodeUpsert.delete(nodeId); purgedForReader.add(nodeId);
      }
      for (const taskId of purge.tasks) {
        if (laterRevived(taskId, purge.at)) continue;
        taskDelete.add(taskId); taskUpsert.delete(taskId); nodeDelete.delete(taskId); purgedForReader.add(taskId);
      }
    }
    // A delete carries no content, but the ids of someone else's trashed notes
    // and the names of attributes removed from them are not this reader's to
    // see. Send a delete only for what the client could hold: something it can
    // read now, live or in the trash, or has just lost (revoked).
    const revokedSet = new Set(revoked);
    const trashedReadable = nodeDelete.size + taskDelete.size + attrDeleteList.length > 0
      ? await readableTrashedNodeIds(actor, workspaceId) : new Set<string>();
    const couldHold = (id: string) =>
      readableSet.has(id) || trashedReadable.has(id) || revokedSet.has(id) || purgedForReader.has(id);

    const delta: SyncDelta = {
      last_event_id: lastEventId,
      head_event_id: headEventId,
      membership_epoch: membershipEpoch,
      nodes: { upsert: nodesUpsert, delete: [...nodeDelete].filter(couldHold) },
      edges: { upsert: edgesUpsert, delete: [...edgeDelete], replace_for: edgeReplaceFor },
      pointers: { upsert: pointersUpsert, delete: [], replace_for: edgeReplaceFor },
      note_anchors: { upsert: await anchorRowsForNotes(workspaceId, edgeReplaceFor), replace_for: edgeReplaceFor },
      note_link_bindings: { upsert: await bindingRowsForNotes(workspaceId, edgeReplaceFor), replace_for: edgeReplaceFor },
      canvas_memberships: { upsert: membershipsUpsert, replace_for: edgeReplaceFor },
      tasks: { upsert: tasksUpsert, delete: [...taskDelete].filter(couldHold) },
      attributes: { upsert: attrsUpsert, delete: attrDeleteList.filter((attr) => couldHold(attr.node_id)) },
      // Complete catalog snapshot, not a node projection or a tag delta.
      // An empty list revokes all held metadata; omission keeps the catalog.
      ...(tagCatalogChanged ? { tags: await readTagCatalog(actor, workspaceId) } : {}),
      workspace: wsRes.rows[0] ? workspaceWireRow(wsRes.rows[0]) : null,
      ...(siteSettings?.configFound ? { site_config: siteSettings.site_config, chrome: siteSettings.chrome } : {}),
    };
    return delta;
  });
}

const idList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && isUuid(id)) : [];

/** The NODES_PURGED events `actor` could have held the notes of: those of a
 *  space they are in (even one deleted since, as deleting a space may purge
 *  its notes first), or of a shared space when they are the owner. A token
 *  holds no mirror and gets none. */
async function purgesReadableBy<P extends { spaceId: string }>(
  actor: ActorCtx | null, workspaceId: string, purges: P[],
): Promise<P[]> {
  if (!actor || actor.tokenScope) return [];
  const owner = await isWorkspaceOwner(actor);
  const r = await q<{ id: string }>(
    `SELECT s.id::text FROM spaces s
      WHERE s.workspace_id = $1 AND s.id = ANY($2::uuid[])
        AND (EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.actor_id::text = $3)
             OR (s.kind = 'shared' AND $4::boolean))`,
    [workspaceId, [...new Set(purges.map((p) => p.spaceId).filter(isUuid))], actor.id, owner],
  );
  const readable = new Set(r.rows.map((row) => row.id));
  return purges.filter((p) => readable.has(p.spaceId));
}
