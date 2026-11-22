// Who may use what in the backend — the allowlists behind allowlist.guard.test.ts. Everything not listed is a
// violation; scripts/allowlist-baseline.json must stay empty (strict mode since 2026-10-31), so any violation fails.
// An owner is a path under src/, or a folder when it ends in "/". There is no "not migrated yet" list.

/** A route parses, authorizes through services/spine and answers: these are the only places it may import from. */
// ratchet:list ROUTE_IMPORTS
export const ROUTE_IMPORTS: readonly string[] = [
  "requestContext", // the request-scoped context cell (MCP request actor)
  "routes/params", // path / query parsing helpers
  "routes/sseStream", // the one SSE writer
  "services/",
  "spine/", // writes go through spine/mutate.ts, authority.ts
  "httpError", // shared error → HTTP mapping
  "statusError",
  "downloadHeaders",
  "localDay",
  "utils",
  "types",
  "logger",
];

/** `process.env` is read once, in the config module (not created yet: until it is, every read is baselined). */
// ratchet:list PROCESS_ENV_OWNERS
export const PROCESS_ENV_OWNERS: readonly string[] = ["config.ts"];
/** Periodic jobs are scheduled in one place (not created yet: today's setInterval calls are baselined). */
// ratchet:list SET_INTERVAL_OWNERS
export const SET_INTERVAL_OWNERS: readonly string[] = ["ticker.ts"];
/** Output goes through the logger; the admin CLI prints to its operator (catalog be-admin-cli). */
// ratchet:list CONSOLE_OWNERS
export const CONSOLE_OWNERS: readonly string[] = ["logger.ts", "admin.ts"]; // admin.ts: be-admin-cli（命令列輸出給操作者，不是日誌）
/** Request-scoped context (the open transaction, the cascade's actor, hooks) rides AsyncLocalStorage in one place, so a host without it (browser) installs one provider. */
// ratchet:list ASYNC_HOOKS_OWNERS
export const ASYNC_HOOKS_OWNERS: readonly string[] = ["requestContext.ts"];
/** Only the database module imports the `pg` driver; it picks real Postgres or PGlite and everything else uses its `pool`/`q()`. */
// ratchet:list PG_DRIVER_OWNERS
export const PG_DRIVER_OWNERS: readonly string[] = ["db.ts", "dbPglite.ts"]; // dbPglite.ts: type-only import of pg.Pool for the PGlite stand-in
/** A route reads and writes the database through the service that owns the rows, not through `.query(` / `q(`. */
// ratchet:list ROUTE_SQL_OWNERS
export const ROUTE_SQL_OWNERS: readonly string[] = [];

/** New queries are written with `db` (dbKysely.ts), typed from the migrations. Hand-written `q()`/`client.query` SQL is counted per file in
 *  scripts/allowlist-baseline.json (rule be-raw-sql), which only shrinks; a file not listed there may have none. These files ARE the SQL
 *  transport: db.ts (pool, q, transactions), dbPglite.ts (the PGlite client) and dbKysely.ts (Kysely's driver, which calls q). */
// ratchet:list RAW_SQL_OWNERS
export const RAW_SQL_OWNERS: readonly string[] = ["db.ts", "dbPglite.ts", "dbKysely.ts"];

/** Route files: `routes/*.ts` and a module's own `modules/<id>/routes.ts`. */
export const isRouteFile = (rel: string): boolean => rel.startsWith("routes/") || /^modules\/[^/]+\/routes\.ts$/.test(rel);

export const inOwners = (rel: string, owners: readonly string[]): boolean =>
  owners.some((o) => (o.endsWith("/") ? rel.startsWith(o) : rel === o));

/** Whether an import target (path under src/, no extension) is one of the listed places. */
export const importAllowed = (target: string, allowed: readonly string[]): boolean =>
  allowed.some((a) => (a.endsWith("/") ? target.startsWith(a) : target === a));

/** Fragment helpers whose result a query may embed as SQL text (`WHERE ${readableScopeSql(actor, "n", params)}`), by
 *  the name used at the call site (`name().method` for a method of a factory's result). Each one builds its text only from
 *  constants and from the alias / `$n` placeholder strings its callers pass as literals, never from a value; `file`
 *  is where it is defined (the guard checks the name is still declared there). Anything not listed, and not a
 *  constant, `sqlInt()` or `sqlIdentifier()`, fails be-sql-interpolation. */
// ratchet:list SQL_FRAGMENT_HELPERS
export const SQL_FRAGMENT_HELPERS: Readonly<Record<string, { file: string; why: string }>> = {
  sqlInt: { file: "sqlText.ts", why: "writes an integer (LIMIT, offset) and throws for anything that is not a safe integer" },
  sqlIdentifier: { file: "sqlText.ts", why: "writes a table or column name and throws unless it is a plain lower-case identifier" },
  readableScopeSql: { file: "services/readPolicy.ts", why: "the read-policy predicate for notes; adds only $n placeholders to params" },
  readableSpaceScopeSql: { file: "services/readPolicy.ts", why: "the read-policy predicate for rows that belong to a space" },
  spaceScopeSql: { file: "spine/spaceScope.ts", why: "the space-membership predicate that also covers trashed rows" },
  spaceAccessSql: { file: "spine/spaceAccess.ts", why: "the predicate for spaces an actor can read or manage" },
  writableSpaceIdsSql: { file: "spine/spaceAccess.ts", why: "the subquery of spaces an actor may write to" },
  workspaceOwnerSql: { file: "spine/spaceAccess.ts", why: "the predicate for a workspace's owner" },
  readableNotesSql: { file: "services/history/readableNotes.ts", why: "the read-policy predicate for History, trashed notes optional" },
  eventVisibleSql: { file: "services/eventVisibility.ts", why: "which domain events an audience may see" },
  buildEventQuery: { file: "services/eventQuery.ts", why: "builds the event-list query; every filter value goes through $n parameters" },
  appendFilterClauses: { file: "services/filter/sqlClauses.ts", why: "appends the saved-view filter conditions; field names go through sqlIdentifier, values through $n" },
  attributeSortSql: { file: "services/collectionViewQuery.ts", why: "ORDER BY pieces for an attribute sort; the attribute key is a $n parameter" },
  "textSearchEngine().build": { file: "services/textSearch.ts", why: "the text-search predicate, ordering and terms; the query text is a $n parameter" },
  ownRefSql: { file: "services/functionRefSql.ts", why: "the EXISTS predicate for a note or paragraph holding its own function reference; the function id is a code constant checked against /^[a-z_]+$/" },
  pageSql: { file: "services/paging.ts", why: "LIMIT / OFFSET as $n parameters" },
  blockQuerySql: { file: "services/blockNodes.ts", why: "the SQL of the block nodes a tag query lists; tag ids and scope go through $n parameters" },
  LISTED_NODE_SQL: { file: "spine/reservedNodes.ts", why: "excludes tag definitions and system machinery from listings" },
  NOT_SYSTEM_NODE_SQL: { file: "spine/reservedNodes.ts", why: "excludes system machinery rows" },
  NOT_A_NOTE_CHANGE_SQL: { file: "services/nodeRowProjection.ts", why: "fixed predicate: the event is not a note change" },
  nodeRowColumnsSql: { file: "services/nodeRowProjection.ts", why: "the column list of a node row; flags are booleans" },
  nodeEventMetaJoinSql: { file: "services/nodeRowProjection.ts", why: "the join that adds event metadata to a node row" },
  attributeColumnsSql: { file: "services/syncProjection.ts", why: "the column list of an attribute row" },
  edgeColumnsSql: { file: "services/syncProjection.ts", why: "the column list of an edge row" },
  pointerColumnsSql: { file: "services/syncProjection.ts", why: "the column list of a pointer row" },
  workspaceColumnsSql: { file: "services/syncProjection.ts", why: "the column list of a workspace row" },
  bodyEventSql: { file: "services/history/bodyEvents.ts", why: "which events count as a save of a note's text" },
  versionActorTypeSql: { file: "services/history/bodyEvents.ts", why: "who wrote a save (the source's kind for a carried version); a constant expression over one alias" },
  editEventSql: { file: "services/history/bodyEvents.ts", why: "which events count as an edit" },
  inkEventSql: { file: "services/history/bodyEvents.ts", why: "which events are handwriting changes" },
  saveOnDaySql: { file: "services/history/bodyEvents.ts", why: "the saves of a day (versions, and the events of a tag or system note); the workspace and the day are $n placeholders" },
  startsNewEditSql: { file: "services/history/bodyEvents.ts", why: "the window rule that starts a new edit" },
  lastBodyHashBeforeSql: { file: "services/history/bodyEvents.ts", why: "the last saved text before an event or a time, as placeholders" },
  isTaskSql: { file: "spine/taskIdentity.ts", why: "the task-identity predicate" },
  taskHostLiveSql: { file: "spine/taskIdentity.ts", why: "whether a task's note is live" },
  liveNodeSql: { file: "spine/nodeSql.ts", why: "the node is not in the trash; the alias is a literal from the caller" },
  tagNodeSql: { file: "spine/nodeSql.ts", why: "the node is a tag definition; the alias is a literal from the caller" },
  liveTagNodeSql: { file: "spine/nodeSql.ts", why: "the node is a tag definition and not in the trash; the alias is a literal from the caller" },
  notTagNodeSql: { file: "spine/nodeSql.ts", why: "the node is not a tag definition; the alias is a literal from the caller" },
  hasTaskRefSql: { file: "spine/taskIdentity.ts", why: "whether a node references the tasks function" },
  reservedTagPredicate: { file: "spine/reservedTagKeys.ts", why: "whether a tag is a reserved tag; the key is a registered constant" },
  nodeAliasesSql: { file: "services/wikilinkEdges.ts", why: "the title / slug aliases a link can match" },
  notATaskNodeSql: { file: "services/tasksStore.ts", why: "excludes task rows from note listings" },
  taskBucketCaseSql: { file: "services/tasksStore.ts", why: "the agenda bucket CASE; same rule as @onden/markdown taskBucket" },
  numericValueSql: { file: "services/attributeNumber.ts", why: "casts a stored attribute value to a number only when it is one" },
  seenSql: { file: "modules/rss/items.ts", why: "the 'item was seen' expression over a placeholder" },
  notMutedSql: { file: "modules/rss/mutes.ts", why: "the 'item is not muted for this actor' predicate over a placeholder" },
  stagingCols: { file: "modules/rss/items.ts", why: "the column list of an RSS staging row" },
  siteShowsTagSql: { file: "modules/website/publishing/redaction.ts", why: "whether a published site shows a tag" },
  holderViewsSql: { file: "services/functionRefSql.ts", why: "a node's saved views composed from its function references (the same array the column used to hold)" },
  sqlDayStart: { file: "localDay.ts", why: "the instant a local day starts, from a column or placeholder" },
  sqlLocalDate: { file: "localDay.ts", why: "a timestamp column as a local date" },
  sqlLocalDay: { file: "localDay.ts", why: "a timestamp column as a local day" },
  whiteboardNoteSql: { file: "services/boardStore.ts", why: "which notes a whiteboard lists" },
  whiteboardShownSql: { file: "services/boardStore.ts", why: "which whiteboard cards are shown" },
};

/** The database transport passes its caller's text through (`pool.query(text, params)`, Kysely's compiled SQL into q());
 *  judging that text is the caller's job. Same files as RAW_SQL_OWNERS. */
export const SQL_TEXT_EXEMPT: readonly string[] = RAW_SQL_OWNERS;
