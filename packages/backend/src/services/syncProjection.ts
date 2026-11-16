// The wire shape of the rows a client mirrors besides nodes — edges,
// attributes, pointers and the workspace row — written once and shared by every read surface
// (GET /api/bootstrap, GET /api/sync, POST /api/sync/nodes). Nodes have their
// own: nodeRowProjection.nodeRowColumnsSql.
//
// Selecting `e.*` made the payload follow the table: a new column shipped to
// every client unannounced, and the surfaces could drift apart. Change a
// column list here and all three change together (syncProjection.test.ts).

/** NodeEdge on the client (frontend lib/api.ts), plus origin and created_at. */
export function edgeColumnsSql(alias: string): string {
  return `${alias}.id, ${alias}.source_node_id, ${alias}.target_node_id, ${alias}.edge_type,
    ${alias}.status, ${alias}.origin, ${alias}.created_at`;
}

/** One attribute with its type, inheritance and source (the client mirrors all
 *  of them; a key → value map loses what a rejected write must restore). */
export function attributeColumnsSql(alias: string): string {
  return `${alias}.node_id, ${alias}.key, ${alias}.value, ${alias}.value_type, ${alias}.is_inheritable, ${alias}.source`;
}

/** NotePointer on the client. */
export function pointerColumnsSql(alias: string): string {
  return `${alias}.id, ${alias}.parent_id, ${alias}.target_id, ${alias}.order_key, ${alias}.order_stamp, ${alias}.display_prefix`;
}

/** Workspace on the client (bootstrap, and the sync delta when it changed).
 *  Not membership_epoch: the delta reports that on its own. The module
 *  decisions come as stored; workspaceWireRow turns them into `modules`. */
export function workspaceColumnsSql(alias: string): string {
  return `${alias}.id, ${alias}.name, ${alias}.slug, ${alias}.home_node_id, ${alias}.modules_off, ${alias}.modules_confirmed, ${alias}.time_zone, ${alias}.day_start_hour`;
}
