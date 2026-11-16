import { z } from "zod";
import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import { LISTED_NODE_SQL } from "../../spine/reservedNodes.js";
import { spaceAccess } from "../../spine/spaceAccess.js";
import { readableAmong } from "../readPolicy.js";
import { notATaskNodeSql } from "../tasksStore.js";
import type { AgentTool } from "./types.js";

// The notes under a note, or at the top of a space, in the order the sidebar shows
// them (pinned first, then order_key, order_stamp, id: @onden/markdown compareChildren).
// Read rule: a note's children live in its space, so a note the caller can read
// has readable children, and a space the caller can read has readable top-level
// notes; the ids returned are still checked once more with readableAmong.

const MAX_DEPTH = 3;
const MAX_NODES = 200;
const NESTED_PER_PARENT = 20;

const Args = z.object({
  /** The note whose children to list. */
  id: z.string().uuid().optional(),
  /** Or a space: its top-level notes. */
  spaceId: z.string().uuid().optional(),
  depth: z.number().int().min(1).max(MAX_DEPTH).default(1),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
}).refine((v) => (v.id === undefined) !== (v.spaceId === undefined), { message: "send exactly one of id (a note) or spaceId (a space)" });

type ChildNode = {
  id: string;
  title: string;
  slug: string;
  node_type: string;
  /** Hidden from the sidebar tree; still readable and searchable. */
  hidden: boolean;
  hasChildren: boolean;
  /** Present when depth > 1 and this note's children were listed (at most 20 each). */
  children?: ChildNode[];
  /** True when more children exist than `children` shows. */
  moreChildren?: boolean;
};

type ListChildrenResult = {
  parent: { id: string } | { spaceId: string };
  nodes: ChildNode[];
  /** The offset for the next page of the first level; null at the end. */
  next: number | null;
} | null;

type Row = { id: string; parent_id: string | null; title: string; slug: string; node_type: string; hidden: boolean };

const PINNED_SQL = sql<boolean>`EXISTS (SELECT 1 FROM node_attributes pa WHERE pa.node_id = content_nodes.id AND pa.key = '_pinned' AND pa.value = 'true')`;

const LISTED_SQL = sql<boolean>`${sql.raw(LISTED_NODE_SQL("content_nodes"))} AND ${sql.raw(notATaskNodeSql("content_nodes"))}`;

async function childRows(workspaceId: string, where: { spaceId: string }, limit: number, offset: number): Promise<Row[]> {
  return db.selectFrom("content_nodes")
    .select(["id", "parent_id", "title", "slug", "node_type", "hidden"])
    .where("workspace_id", "=", workspaceId).where("deleted_at", "is", null).where(LISTED_SQL)
    .where("space_id", "=", where.spaceId).where("parent_id", "is", null)
    .orderBy(PINNED_SQL, "desc").orderBy(sql`order_key COLLATE "C"`).orderBy(sql`order_stamp COLLATE "C"`).orderBy("id")
    .limit(limit).offset(offset).execute() as Promise<Row[]>;
}

/** The first `perParent` children of each of `parentIds` (sidebar order), so a parent with many children never uses up
 *  the rows of the parents after it. */
async function childRowsOf(workspaceId: string, parentIds: string[], perParent: number, offset = 0): Promise<Row[]> {
  return db.selectFrom((eb) => eb.selectFrom("content_nodes")
    .select(["id", "parent_id", "title", "slug", "node_type", "hidden"])
    .select(sql<number>`row_number() OVER (PARTITION BY parent_id ORDER BY ${PINNED_SQL} DESC, order_key COLLATE "C", order_stamp COLLATE "C", id)`.as("rn"))
    .where("workspace_id", "=", workspaceId).where("deleted_at", "is", null).where(LISTED_SQL)
    .where("parent_id", "in", parentIds).as("c"))
    .select(["c.id", "c.parent_id", "c.title", "c.slug", "c.node_type", "c.hidden"])
    .where("c.rn", ">", offset).where("c.rn", "<=", offset + perParent)
    .orderBy("c.parent_id").orderBy("c.rn").execute() as Promise<Row[]>;
}

async function parentsWithChildren(workspaceId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.selectFrom("content_nodes").select("parent_id").distinct()
    .where("workspace_id", "=", workspaceId).where("deleted_at", "is", null).where("parent_id", "in", ids)
    .where(sql<boolean>`${sql.raw(LISTED_NODE_SQL("content_nodes"))} AND ${sql.raw(notATaskNodeSql("content_nodes"))}`).execute();
  return new Set(rows.flatMap((r) => (r.parent_id ? [r.parent_id] : [])));
}

export const listChildren: AgentTool<z.infer<typeof Args>, ListChildrenResult> = {
  name: "listChildren",
  access: "read",
  description:
    "List the notes under a note (id) or at the top level of a space (spaceId, from listSpaces), in the order the sidebar shows them. " +
    "Each entry has id, title, slug, node_type, hidden and hasChildren. depth 1 (default) lists direct children; depth 2-3 also nests " +
    "their children (at most 20 per note, `moreChildren` says there are more; call again with that note's id). Deleted notes, tasks and " +
    "tag definitions are not listed. Returns null if the note or space is not found or you cannot read it. Page with limit/offset.",
  inputSchema: Args,
  async handler(args, { actor, workspaceId }) {
    if (args.id !== undefined) {
      if (!(await readableAmong(actor, workspaceId, [args.id])).has(args.id)) return null;
    } else {
      const access = await spaceAccess(actor, args.spaceId!);
      if (!access?.read) return null;
    }
    const first = args.id !== undefined
      ? await childRowsOf(workspaceId, [args.id], args.limit + 1, args.offset)
      : await childRows(workspaceId, { spaceId: args.spaceId! }, args.limit + 1, args.offset);
    const page = first.slice(0, args.limit);
    const all = new Map<string, ChildNode>();
    const toNode = (row: Row): ChildNode => ({ id: row.id, title: row.title, slug: row.slug, node_type: row.node_type, hidden: row.hidden, hasChildren: false });
    const top = page.map(toNode);
    top.forEach((n) => all.set(n.id, n));
    let budget = MAX_NODES - top.length;
    let level = top;
    // Notes whose children the caller asked to see (depth) — those left unlisted for lack of budget say `moreChildren`.
    const nestedAsked = new Set<string>(args.depth >= 2 ? top.map((n) => n.id) : []);
    for (let d = 2; d <= args.depth && level.length > 0 && budget > 0; d++) {
      // One more than shown, to know whether there are more.
      const rows = await childRowsOf(workspaceId, level.map((n) => n.id), NESTED_PER_PARENT + 1);
      const byParent = new Map<string, Row[]>();
      for (const row of rows) byParent.set(row.parent_id!, [...(byParent.get(row.parent_id!) ?? []), row]);
      const next: ChildNode[] = [];
      for (const parent of level) {
        const kids = byParent.get(parent.id) ?? [];
        const shown = kids.slice(0, Math.min(NESTED_PER_PARENT, budget));
        budget -= shown.length;
        parent.children = shown.map(toNode);
        if (shown.length < kids.length) parent.moreChildren = true;
        for (const kid of parent.children) { all.set(kid.id, kid); next.push(kid); }
      }
      if (d < args.depth) next.forEach((n) => nestedAsked.add(n.id));
      level = next;
    }
    const withKids = await parentsWithChildren(workspaceId, [...all.keys()]);
    for (const node of all.values()) {
      node.hasChildren = withKids.has(node.id);
      // Asked for (depth) but not listed, because the call's node budget ran out: say so rather than show nothing.
      if (node.hasChildren && node.children === undefined && nestedAsked.has(node.id)) node.moreChildren = true;
    }
    // Defence in depth: nothing leaves this tool that readableAmong would not return for the caller.
    const readable = await readableAmong(actor, workspaceId, [...all.keys()]);
    const prune = (nodes: ChildNode[]): ChildNode[] => nodes.filter((n) => readable.has(n.id)).map((n) => (n.children ? { ...n, children: prune(n.children) } : n));
    return {
      parent: args.id !== undefined ? { id: args.id } : { spaceId: args.spaceId! },
      nodes: prune(top),
      next: first.length > args.limit ? args.offset + args.limit : null,
    };
  },
};
