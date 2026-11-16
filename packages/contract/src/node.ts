// The shape of a note (a "node") between the server and the app, defined once.
// The backend gives its node rows this type, the app derives its ContentNode
// from it, and packages/backend/src/test/nodeContract.integration.test.ts
// parses real responses with `.strict()`, so a column added or dropped on one
// side fails a test instead of drifting. The app imports TYPES from here
// (`import type`): zod must stay out of its boot bundle.
//
// Not covered yet (later cuts): tags' schema, canvases, tasks, edges.

import { z } from "zod";
import { NODE_MARKDOWN_MAX, NODE_TITLE_MAX } from "@onden/markdown";
import { isValidOrderKey } from "@onden/markdown/contract";

/** A string Postgres can store: U+0000 is refused with a 400 instead of
 *  failing later as an unmapped database error (22021). */
export const noNul = (schema: z.ZodString) => schema.refine((v) => !v.includes("\u0000"), { message: "contains_nul" });

/** What the app (or an agent) sends to create a note (POST /api/nodes) or to
 *  change one (PATCH /api/nodes/:id, where every key is optional and only the
 *  keys sent count). The extras only creation takes (tags, attributes, space)
 *  are newNoteExtrasSchema in the backend. */
export const DraftNode = z.object({
  id: z.string().uuid().optional(),
  title: noNul(z.string().min(1).max(NODE_TITLE_MAX)),
  markdown: noNul(z.string().max(NODE_MARKDOWN_MAX)).default(""),
  node_type: z.enum(["content"]).default("content"),
  source_type: z.enum(["manual", "rss", "ai"]).default("manual"),
  parent_id: z.string().uuid().nullable().optional(),
  hidden: z.boolean().default(false),
  /** Where the note sits among its siblings: a key between its neighbours' keys (@onden/markdown keyBetween). Absent on
   *  a create = last among its siblings. */
  order_key: z.string().refine(isValidOrderKey, { message: "invalid_order_key" }).optional(),
  /** LEGACY (before order keys, migration 200): the integer an older app or a queued offline write still sends. The
   *  server turns it into a key (services/orderKeys.ts translateLegacySortOrder); nothing sends or reads it any more. */
  sort_order: z.number().int().optional(),
  presentation: z.record(z.string(), z.unknown()).nullable().optional(),
});
/** What the server reads after defaults. */
export type DraftNode = z.infer<typeof DraftNode>;

/** One saved view of a note's children. Stored as jsonb and read by the app
 *  through lib/ownerViews, so only the keys the app looks at are named. */
const NodeViewRecord = z.looseObject({
  id: z.string().optional(),
  layout: z.string().optional(),
  layout_config: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** A note as the database holds it (content_nodes), as the server sends it
 *  right after a create or an edit (POST and PATCH /api/nodes). Times are ISO
 *  strings, bigint ids are strings. */
export const ServerNodeRow = z.object({
  id: z.string(),
  workspace_id: z.string(),
  // 'system' = backend-maintained machinery rows (the Site Config note).
  source_type: z.enum(["manual", "rss", "ai", "system"]),
  // 'canvas' is the retired kind of a whiteboard note (migration 138): a local
  // copy, or a server from before, may still carry it.
  node_type: z.enum(["content", "class_tag", "canvas"]),
  title: z.string(),
  slug: z.string(),
  markdown: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  parent_id: z.string().nullable(),
  hidden: z.boolean(),
  order_key: z.string(),
  /** The stamp of the write that set `order_key` ('' when none): ties on the key are ordered by it, then by id. */
  order_stamp: z.string(),
  presentation: z.record(z.string(), z.unknown()).nullable(),
  collection_views: z.array(NodeViewRecord).nullable(),
  /** Soft-delete tombstone; null while the note is live. */
  deleted_at: z.string().nullable(),
  /** Event id (bigint over JSON) of the delete, when trashed. */
  deleted_by_event_id: z.string().nullable(),
  // class_tag rows carry their tag's colour, schema and role inline.
  tag_color: z.string().nullable(),
  tag_schema: z.unknown(),
  reserved_key: z.string().nullable(),
  /** Progress of moving block ids out of the text (migration 180): 0 may still carry `^id` marks, 1 converted or new, 2 left as is. Server bookkeeping; clients ignore it. */
  anchor_form: z.number().optional(),
  /** The note's space; null on tag definitions. */
  space_id: z.string().nullable(),
});

/** The reply to creating a note (POST /api/nodes): the row, plus `attrs` — only the note's place on the site
 *  (`_published`, `_published_by_parent`) as stored, `{}` when it has neither. A device that drew a prediction while
 *  the request was out settles on it (backend services/siteDefault.ts). An older app ignores the field. */
export const CreatedNode = ServerNodeRow.extend({ attrs: z.record(z.string(), z.string()) });

/** A note as every read surface sends it (bootstrap, the sync delta, GET
 *  /api/nodes/:id; services/nodeRowProjection.ts): the row plus its tags,
 *  attributes and who changed it. */
export const ServerNode = ServerNodeRow.extend({
  /** Ids of the applied tags that have a schema (class tags). */
  class_tag_ids: z.array(z.string()),
  /** Ids of the applied schema-less tags (#toread). */
  label_tag_ids: z.array(z.string()),
  /** Every attribute as {key: value}; absent on a lean bootstrap, which sends
   *  the typed attribute rows once instead. */
  attrs: z.record(z.string(), z.string()).optional(),
  /** Slim bootstrap (?bodies=none): `markdown` is "" and this is the real body
   *  length in characters. Absent when the body is sent. */
  body_len: z.number().optional(),
  /** Event metadata, presentational only (never a permission decision). */
  last_actor: z.string().nullable(),
  last_modified_at: z.string().nullable(),
  recent_actors: z.array(z.string()),
});

export type ServerNodeRow = z.infer<typeof ServerNodeRow>;
export type ServerNode = z.infer<typeof ServerNode>;

/** A note as the app holds it. The server's shape is ServerNode; this type only says which of those fields a note made
 *  on this device may lack until the server has sent it: the app builds optimistic local nodes with just the core
 *  fields, while every row from the server carries them all. There are no app-only fields. */
type CoreNodeKey = "id" | "source_type" | "node_type" | "title" | "slug" | "markdown";
export type ContentNode = Pick<ServerNode, CoreNodeKey> & Partial<Omit<ServerNode, CoreNodeKey>>;
