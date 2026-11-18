import { NODE_TITLE_MAX } from "./noteLimits.js";
import type { InkShapeKind } from "./inkFormat.js";

// Values the server and the app must agree on, written once. Each used to be
// defined on both sides with a "keep equal to ..." comment (and, for the
// password rules, a test that read the other package's source). They are
// plain data, so the one definition lives here and both sides import it;
// guards/crossPackage.guard.test.ts fails if a side defines one again.

/** The module id of the tasks module; also the function id a task node references (function_refs). */
export const TASKS_MODULE_ID = "tasks";

/** The namespace a day note's id is derived in: uuid v5 of `dayNoteIdName(space, day)` here.
 *  Every device — and the server, when it starts a day note — derives the same
 *  id for one (space, day), so two that start the same day offline send the
 *  same create and the server keeps one. A random v4, never change it: existing
 *  day notes are found by this derivation. Migration 147 repeats it in SQL. */
export const DAY_NOTE_NAMESPACE = "6f0b7a52-3c1e-4d5a-9a3e-2b8f4c7d1e60";
/** What the id is derived from: the space and a day (YYYY-MM-DD) — or, for a
 *  space's note that holds tasks which have no day, `TASKS_NOTE_TITLE`. */
export const dayNoteIdName = (spaceId: string, day: string): string => `${spaceId}/${day}`;
/** The namespace the ids of things Onden makes by itself are derived in (migration 201): the capture and skills tags, the
 *  site-settings tag and note, a workspace's default and system spaces, a person's personal space, the next occurrence of
 *  a recurring task and an RSS article. uuid v5 of `derivedIdName(...)` here, the same mechanism as a day note's id
 *  (`DAY_NOTE_NAMESPACE`): two devices that each make one of these while offline make it with the same id, so a merge
 *  sees one row. A random v4, never change it: existing rows are found by this derivation. Migration 201 repeats it in SQL
 *  (`onden_uuid5`). */
export const DERIVED_ID_NAMESPACE = "c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47";
/** What each derived id is made from. The first word says what the row is for; the rest is what makes it the only one:
 *  the workspace (or the space, the actor, the series, the feed). The strings are part of the contract — migration 201
 *  and `derivedIdName` must give the same text. */
export const derivedIdName = {
  moduleTag: (workspaceId: string, module: string): string => `module-tag/${module}/${workspaceId}`,
  reservedTag: (workspaceId: string, key: string): string => `reserved-tag/${key}/${workspaceId}`,
  siteConfigNote: (workspaceId: string): string => `site-config-note/${workspaceId}`,
  systemSpace: (workspaceId: string): string => `system-space/${workspaceId}`,
  defaultSpace: (workspaceId: string): string => `default-space/${workspaceId}`,
  personalSpace: (workspaceId: string, actorId: string): string => `personal-space/${workspaceId}/${actorId}`,
  /** The occurrence a recurring task makes when `previousOccurrenceId` is completed or missed: one successor per occurrence. */
  taskSuccessor: (previousOccurrenceId: string): string => `task-successor/${previousOccurrenceId}`,
  /** An article of a feed, by the feed's subscription and the article's own identity (its guid). */
  rssArticle: (subscriptionId: string, guid: string): string => `rss-article/${subscriptionId}/${guid}`,
};
/** The title of the note a space's tasks with no day are written into. */
export const TASKS_NOTE_TITLE = "任務";

/** The statuses a task may be set to; todo and doing are "open". `later` is the
 *  old "parked": an older client may still send it, and the write makes it todo +
 *  someday; the agenda never reports it. */
export const TASK_STATUSES = ["todo", "doing", "waiting", "later", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Roles of the system-reserved tags (key → the title a new one gets). A tag's
 *  `reserved_key` is one of the values, whatever the tag is titled. (#task was
 *  reserved until migration 135.) */
export const RESERVED_TAGS = { config: "workspace-config", page: "page" } as const;
export type ReservedTagKey = (typeof RESERVED_TAGS)[keyof typeof RESERVED_TAGS];

/** The reserved attribute keys a task keeps its state under (a note that was once a task by its tag keeps its values). */
export const TASK_ATTR = {
  status: "_task_status",
  /** YYYY-MM-DD: the day to do it (migration 135: was `_task_due`). */
  when: "_task_when",
  /** "true": do it in the evening of `when`. Only meaningful with a `when`. */
  evening: "_task_evening",
  /** "true": no day, do it whenever (parked). Migration 135: was status `later`. */
  someday: "_task_someday",
  /** YYYY-MM-DD: the last day it may be done. */
  deadline: "_task_deadline",
  recur: "_task_recur",
  /** fixed | after (absent = fixed): see modules/tasks/recurrence.ts. */
  recurMode: "_task_recur_mode",
  /** ISO instant, or a wall-clock YYYY-MM-DDTHH:MM[:SS] in the workspace's zone. */
  remindAt: "_task_remind_at",
  /** HH:MM: the clock time it starts, written at the start of its line (taskTime.ts). */
  time: "_task_time",
  /** HH:MM later than `time`: when it ends. Only meaningful with a `time`. */
  until: "_task_until",
  /** ISO instant the status last became done; absent while it is not done. */
  doneAt: "_task_done_at",
} as const;

/** Edge types a published page renders. The server's snapshot query takes
 *  exactly these; the app's `isPublishedEdge` applies the same rule. */
export const PUBLISHED_EDGE_TYPES = ["knowledge_link", "suggested_link", "nav_link"] as const;

/** The note's own say on the site: `_published` 'false' is 「不發布」, 'true' is 「發布」. */
export const PUBLISHED_ATTR_KEY = "_published";
/** Set (value 'true') next to a 「不發布」 that nobody chose on this note: it was
 *  made under a note that was kept off the site and took that as its default
 *  (newNoteSiteDefault). Any later write of `_published`, 「放回網站」 included,
 *  removes it, so a 「不發布」 still carrying it is always the inherited one. */
export const KEPT_OFF_BY_PARENT_ATTR_KEY = "_published_by_parent";

/** The one rule for whether a NEW note starts kept off the site because of where
 *  it is made (owner 2026-11-13): when its direct parent is 「不發布」 it is too.
 *  Only the direct parent counts: a note put back (「放回網站」) under a kept-off
 *  one makes its own children publish as usual. Returns the attributes to give
 *  the new note, or null. Existing notes are never re-judged, and moving a note
 *  does not apply this. The server writes them (createNote); the app predicts
 *  them offline with this same function, so the two cannot disagree. */
export function newNoteSiteDefault(parentAttrs: Readonly<Record<string, string>> | null | undefined): Record<string, string> | null {
  return parentAttrs?.[PUBLISHED_ATTR_KEY] === "false"
    ? { [PUBLISHED_ATTR_KEY]: "false", [KEPT_OFF_BY_PARENT_ATTR_KEY]: "true" }
    : null;
}

/** Most notes one "rewind the workspace to a day" may touch. */
export const REWIND_MAX_NOTES = 2000;

/** Rows a published tag page lists (the studio preview cuts at the same number). */
export const TAG_PAGE_ROWS_MAX = 100;

/** Password length the sign-up form states and the auth config enforces. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Longest names, in UTF-16 units, the server accepts and the inputs allow:
 *  a tag, a saved view, a shared space, a task title (a note's own title limit is
 *  NODE_TITLE_MAX, noteLimits.ts). An input whose `maxLength` is smaller than the
 *  server's would cut what the agent tools and imports can write. */
export const TAG_NAME_MAX = 200;
export const VIEW_NAME_MAX = 80;
export const SPACE_NAME_MAX = 80;
export const TASK_TITLE_MAX = NODE_TITLE_MAX;
/** A followed calendar's name (external_calendars; the table's CHECK in migration 160 says the same). */
export const EXTERNAL_CALENDAR_NAME_MAX = 60;
/** A saved pen preset's name, in characters (the pen presets in an account's preferences; the field in the toolbar and the stored list use the same limit). */
export const INK_PRESET_NAME_MAX = 24;
/** An AI's name, and the name of one of its connections (a kept key's label, a connection code's name). */
export const AI_NAME_MAX = 80;

/** The fields a note row carries on its top level (everything else is an
 *  attribute). The saved-view filter, sort and column rules on the server
 *  (services/filter/sqlClauses.ts) and the collection layouts read the same list. */
const BUILT_IN_FIELD_NAMES = ["title", "slug", "updated_at", "created_at", "sort_order"] as const;
/** The fields a note row carries on its top level, as a set: the one test of "is this field a column of the row or an attribute". */
export const BUILT_IN_FIELDS: ReadonlySet<string> = new Set(BUILT_IN_FIELD_NAMES);

/** The comparisons a saved-view filter may use. The server validates a clause
 *  against these (nodeQuery.ts); the view builder offers them. */
export const FILTER_OP_NAMES = ["eq", "ne", "contains", "empty", "nempty", "gt", "gte", "lt", "lte"] as const;
export type FilterOpName = (typeof FILTER_OP_NAMES)[number];

/** A custom domain as typed: a pasted address loses its scheme and path, and
 *  the host is lower-cased. Settings checks it as typed; the server checks it
 *  again before writing the CNAME file, with the same two functions. */
export function cleanCustomDomain(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
}

/** A bare host name (apex or sub-domain): no scheme, path, port or whitespace. */
export function isCustomDomainHost(host: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host);
}

/** A key starting with `_` is the system's own (task state, pin, colour, the
 *  published flag, provenance stamps): never listed as a property, never
 *  exported or imported as one, and a client may only write the few the
 *  server names (services/systemAttributes.ts). The one place that says so. */
export function isSystemAttr(key: string): boolean {
  return key.startsWith("_");
}

/** Attributes the editors store for their own content (handwriting strokes,
 *  PDF marks, sketches): drawn on the page, never listed as a field to edit.
 *  They are not `_`-prefixed, so a property list asks for both. */
export const EDITOR_STORAGE_ATTR_KEYS: ReadonlySet<string> = new Set(["ink_data", "page_text", "page_images", "board_ink", "note_ink", "pdf_annotations", "pdf_page", "pdf_url", "sketch_data", "slides_data"]);
/** Where a note keeps a drawing page. `ink_data` is the note's own content: a handwriting page, or a PDF's
 *  envelope. `board_ink` is the pen layer of its whiteboard view (the same single-page format, the same codec,
 *  the same merging write): a separate attribute so that drawing on the board never turns the note's content
 *  tab into a handwriting page, and a handwriting page's strokes never show on the board. */
export const INK_DATA_ATTR = "ink_data";
export const BOARD_INK_ATTR = "board_ink";
/** The strokes of a note's 「手寫」 tab (a view of the note, docs/agents/decisions-canvas.md 手寫分頁): the same pages
 *  format as a handwriting note's (`ink_data`) — first page in the document, the rest in `morePages` — but a separate
 *  attribute, so that a note with text can have strokes without its content tab turning into a handwriting page. It is
 *  the note's own data: removing the tab does not touch it. */
export const NOTE_INK_ATTR = "note_ink";
/** The layout (= the handwriting module's id) of the stored view that is a note's 「手寫」 tab. */
export const HANDWRITING_LAYOUT = "handwriting";
/** Every attribute that holds drawing data in the ink page format (large, merged on write, content-addressed in
 *  history, left out of the lean bootstrap). */
export const INK_PAGE_ATTRS = [INK_DATA_ATTR, BOARD_INK_ATTR, NOTE_INK_ATTR] as const;
export function isInkPageAttr(key: string): boolean {
  return (INK_PAGE_ATTRS as readonly string[]).includes(key);
}
/** Which drawing a History row is about: the note's own handwriting page (`ink_data`) or its whiteboard's pen
 *  layer (`board_ink`) or its 「手寫」 tab (`note_ink`). The history API takes it as `?kind=`; restoring a version writes only that kind's attribute. */
export const INK_KINDS = ["handwriting", "board", "note"] as const;
export type InkKind = typeof INK_KINDS[number];
export const INK_KIND_ATTR: Readonly<Record<InkKind, typeof INK_PAGE_ATTRS[number]>> = { handwriting: INK_DATA_ATTR, board: BOARD_INK_ATTR, note: NOTE_INK_ATTR };
export function isInkKind(value: unknown): value is InkKind {
  return (INK_KINDS as readonly unknown[]).includes(value);
}
// Here, not in inkFormat.ts or inkShapes.ts: a screen that only lists the kinds (the pen defaults read at boot)
// would otherwise load the stored-format code or the shape geometry with it.
/** The kinds the shape button offers, in its order ("circle" is only read). */
export const INK_SHAPE_KINDS: readonly InkShapeKind[] = [
  "line", "arrow", "rectangle", "roundedRectangle", "ellipse", "triangle", "diamond", "star",
];
export function isEditorStorageAttr(key: string): boolean {
  return EDITOR_STORAGE_ATTR_KEYS.has(key);
}

/** The sync protocol: the header a client sends to say which protocol it speaks, and the one every API response
 *  carries to say which the server speaks. Two sides sync only when the numbers are EQUAL: there is no range of
 *  versions that still work together. Different means neither side sends or accepts sync or writes; the changes stay
 *  where they were made, the person is told which side to update, and what waited goes out once the numbers match.
 *  The older side is the one to update: a server refuses an older client (426 `client_too_old`: reload) and a newer
 *  one (426 `server_too_old`: the server needs updating); a client holds back from a server on either side the same way.
 *  Raise CLIENT_PROTOCOL when the shape of what sync carries changes (bootstrap, delta, membership) or a write means
 *  something else than before (3: paragraph identity lives in block_anchors, the text carries no `^id`; 4: a note's
 *  place among its siblings is the key `order_key`, not the integer `sort_order`). A new
 *  optional field, a new route or a bug fix does not need it: raising it locks everyone out until both sides update.
 *  A request with no header (MCP, tokens, health checks, the public site) is not asked. */
export const CLIENT_PROTOCOL_HEADER = "X-Onden-Client-Protocol";
export const SERVER_PROTOCOL_HEADER = "X-Onden-Server-Protocol";
export const CLIENT_PROTOCOL = 4;

/** The requests that carry what sync builds a copy from (bootstrap, delta, bodies, drawings, membership, grants), by
 *  path. Some are POSTs that only read, so "is it a write" is not the question: the server refuses a client
 *  of another protocol on these whatever the method, and a page refuses to send them to a server of another protocol. One list for both. */
export const SYNC_PATH_PREFIXES = ["/api/sync", "/api/bootstrap"] as const;
export function isSyncPath(path: string): boolean {
  const pathname = path.split("?")[0]!;
  return SYNC_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** How the other side's protocol header relates to this build's CLIENT_PROTOCOL: `null` when it is the same. Anything
 *  that is not a whole number counts as "older" (a build that predates the header's meaning). Absent or blank is not
 *  asked here: the caller decides what no header means. */
export function protocolMismatch(headerValue: string): "older" | "newer" | null {
  const version = Number(headerValue);
  if (!Number.isInteger(version) || version < CLIENT_PROTOCOL) return "older";
  return version > CLIENT_PROTOCOL ? "newer" : null;
}

/** Names the browser or install a write came from: one UUID per device, made once and never synced between devices
 *  or changed by signing in as someone else. The server records it on the write's event (`domain_events.device_id`)
 *  and never sends it back. A missing or malformed value is "no device" (MCP and API tokens have none); never a refusal. */
export const DEVICE_ID_HEADER = "X-Onden-Device-Id";

/** The device's own clock (epoch ms) at the moment a request is SENT, on every request, also one replayed from the offline queue.
 *  A device's clock can be hours off, so the server never compares a device-dated edit time with its own time: it turns the
 *  edit time into an age with this reading (the device's error cancels) and dates the edit on its own logical clock
 *  (backend clientClock.ts). Missing or malformed: no age is known and the edit counts as made when it arrived; never a refusal. */
export const CLIENT_NOW_HEADER = "X-Onden-Client-Now";

/** Most entries one board write (PATCH /api/boards/:id) carries in each of `cards.upsert` and `cards.remove`.
 *  The server's schema refuses more; the app cuts a larger change into requests of at most this many. */
export const BOARD_CARDS_PER_REQUEST_MAX = 5000;
/** The same for `sections.upsert` and `sections.remove`. */
export const BOARD_SECTIONS_PER_REQUEST_MAX = 1000;

/** The kinds a content node can be (`content_nodes.node_type`). The one place the names are written:
 *  the server's SQL (`spine/nodeSql.ts`) and the app's predicates below build on these, so no
 *  other file spells `'class_tag'` out (guards/nodeKind.guard.test.ts counts the ones left). */
export const NODE_TYPE = { content: "content", tag: "class_tag", canvas: "canvas" } as const;
export const TAG_NODE_TYPE = NODE_TYPE.tag;

/** Whether the row is a tag definition. Tolerates a missing row (`isTag(rows[0])`) so a lookup that may find
 *  nothing needs no `?.`; for a row that must exist, the type still demands `node_type`. */
export function isTag<N extends { readonly node_type?: unknown }>(node: N | null | undefined): node is N & { readonly node_type: typeof NODE_TYPE.tag } {
  return node?.node_type === NODE_TYPE.tag;
}
/** An ordinary note (`content`): not a tag definition, not a canvas. */
export function isNote(node: { readonly node_type?: unknown } | null | undefined): boolean {
  return node?.node_type === NODE_TYPE.content;
}
export function isCanvas(node: { readonly node_type?: unknown } | null | undefined): boolean {
  return node?.node_type === NODE_TYPE.canvas;
}

// A rule both sides apply to the same change: where a task's reminder goes when its day or time moves (the server on the
// write, the client on its optimistic copy). Offered here, not from the root entry, which only gets narrower.
export { reminderAfterMove, type ReminderPlacement } from "./taskReminder.js";

// Same-level order keys (migration 200): the one place they are made and compared, shared by the app and the server.
export { keyBetween, keysBetween, evenOrderKey, evenOrderKeys, isValidOrderKey, orderKeyNeedsRespace, compareOrdered, ORDER_KEY_RESPACE_LENGTH, ORDER_KEY_MAX_LENGTH } from "./orderKey.js";

// ── The tag-name shape ──────────────────────────────────────────────────────
// A tag name must be writable as a tag in a note, and what is written as a tag must not be mistaken for anything else.
// A note names a tag three ways: `#name` (letters, digits, `_`, `-` only: text.ts HASHTAG_RE), `{a, b}` at the end of a block
// (blocks.ts: one line, split on `,`, trimmed, an item with `:` is not a tag) and a path `#a/b` or `{a/b}` (split on `/`). The
// `{…}` form is the widest — spaces and any script work there — so the rule is the one of that form:
//   - no `/`, `#`, `,`, `:`, `{`, `}` or control character (newline, tab): they are the grammar's own marks;
//   - none of `; ( ) [ ] = < > " ' \` * | \ $`: the marks of program text. `^[ \t]+ { indent(); ECHO; }` typed as a
//     paragraph ends in braces too, and must stay text (the owner's Lex notes became tags, 2026-11-17);
//   - no space at either end, not empty.
// `研究`, `reading list`, `C++`, `Q&A` and `讀書（小說）` are valid; `#研究` (the marker is not part of the name), `a/b`,
// `C#`, `x, y`, `key:value`, `f(x)` and `it's` are not. For a tag's NAME only a new one is checked (create, rename, undo
// of a rename, pack install: the backend's assertTagNameShape): a tag whose name predates the rule still loads, and can
// be renamed to a valid one.
const TAG_NAME_FORBIDDEN = /[/#,:{};()[\]=<>"'`*|\\$\p{Cc}]/u;

// One exception: the number a name gets when two tags of the same name meet — "idea (2)". Sync and merge give the later
// one that name (tagClashName below is the one place it is formed: stampedMerge/rules/names.ts, the old distributedSync
// bridge). The app makes such names itself, so they must be names, and `{idea (2)}` must be that tag. A person may type
// such a name too; the code that numbers a clash takes the next number that is free.
const CLASH_NUMBER = /(?: \(\d+\))+$/;

/** The name the `n`-th tag called `name` is shown under when same-name tags meet (n ≥ 2): "idea (2)". */
export function tagClashName(name: string, n: number): string {
  return `${name} (${n})`;
}

/** Whether `name` can be a tag's name (the rule above). */
export function isTagNameShape(name: string): boolean {
  return name.length > 0 && name.trim() === name && !TAG_NAME_FORBIDDEN.test(name.replace(CLASH_NUMBER, ""));
}
