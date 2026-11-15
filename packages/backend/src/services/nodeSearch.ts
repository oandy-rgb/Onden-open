import { q } from "../db.js";
import { readableScopeSql } from "./readPolicy.js";
import { notATaskNodeSql } from "./tasksStore.js";
import { TASK_FUNCTION_ID, hasTaskRefSql } from "../spine/taskIdentity.js";
import { memberTagIdsNamed } from "./tagHierarchy.js";
import { NOT_SYSTEM_NODE_SQL } from "../spine/reservedNodes.js";
import type { ActorCtx } from "../types.js";
import { parseSearchQuery, snippetAround, type Snippet } from "@onden/markdown";
import { textSearchEngine } from "./textSearch.js";

import { liveNodeSql } from "../spine/nodeSql.js";
// Node search extracted from routes/nodes.ts. Parses the query DSL
// (text + #tag + key:value filters), builds a positional-parameter WHERE clause,
// and runs it through the text engine (services/textSearch.ts: pgroonga on the
// server, a portable ILIKE engine where it is not installed). Kept as a service so the route handler is thin
// and the query-building is testable against a real index.
//
// Query syntax: q="kafka #book status:reading"
//   → text "kafka" via pgroonga + node carries #book + attribute status="reading"
// Filters compose with AND. A pure-filter query (e.g. "#book") is valid; a
// pure-text query needs >= 2 chars (enforced by the caller on the raw string).
//
// `actor` is REQUIRED (read-policy iron law): the caller's COMBINED read scope
// is pushed INTO the WHERE so the LIMIT lands on already-authorized rows. The
// route must not post-filter a materialized result (that under-fills a low-rank
// caller's page). Pass null for the anonymous/public reader.

export type NodeSearchResult = {
  id: string;
  title: string;
  slug: string;
  node_type: string;
  /** Plain text around the first body match plus the ranges to highlight
   *  (@onden/markdown snippet.ts) — never HTML. null when no text matched the
   *  body (a title-only or pure-filter hit). */
  snippet: Snippet | null;
  /** A task (hidden #task node), only ever returned when the caller asked for
   *  tasks: the result reads as a task, not a note to open in the editor. */
  is_task: boolean;
};

export type NodeSearchOptions = {
  /** Also return tasks. Off by default: a task is not a note a reader opens
   *  (the agenda lists them); the `[[` picker and the task pages ask for them. */
  tasks?: boolean;
};

export async function searchNodes(workspaceId: string, raw: string, actor: ActorCtx | null, limit = 30, options: NodeSearchOptions = {}): Promise<NodeSearchResult[]> {
  const parsed = parseSearchQuery(raw);

  // Reject empty queries: text plus filters must add up to something.
  if (parsed.text.length === 0 && parsed.tags.length === 0 && parsed.attrs.length === 0) {
    return [];
  }

  // Build the WHERE clause piece by piece — sticky on positional parameters
  // so we can route an arbitrary number of tag / attr filters cleanly.
  const params: unknown[] = [workspaceId];
  // Task rows are tasks, not notes a reader opens (the agenda lists them). A
  // note the user hid from the tree stays searchable: hiding tidies the tree,
  // it doesn't make a note unfindable (compositionLaws HIDDEN×CAPABLE).
  // System machinery (the Site Config note, the workspace-config tag) is never
  // a result, as in /api/query and saved views (reservedNodes.NOT_SYSTEM_NODE_SQL):
  // the palette doesn't list it, and the AI's searchNotes tool must not find it.
  const where: string[] = [`n.workspace_id = $1`, liveNodeSql("n"), NOT_SYSTEM_NODE_SQL("n")];
  if (!options.tasks) where.push(notATaskNodeSql("n"));

  // Text predicate, ordering and highlight terms come from the engine; null when the query is filters only.
  const text = parsed.text.length > 0 ? (await textSearchEngine()).build("n", parsed.text, params) : null;
  if (text) where.push(text.match);

  // Tag filters: join via EXISTS so the row is required to be under every
  // tag. "Under" is the one membership rule (tagHierarchy.memberTagIds: the
  // tag, its child tags and the tags extending it), every tag with the name
  // counting, as /api/query `tags` and the tag page count it — `#課程` finds a
  // note tagged only 課程/演算法. An unknown name matches nothing.
  for (const tag of parsed.tags) {
    params.push(await memberTagIdsNamed(workspaceId, [tag]));
    // A task node is under the tasks module's tag without a node_tags row (it references the function), so
    // `#task` with tasks=1 still finds tasks.
    where.push(
      `(EXISTS (
         SELECT 1 FROM node_tags nt
         WHERE nt.node_id = n.id AND nt.tag_id = ANY($${params.length}::uuid[])
       ) OR (${hasTaskRefSql("n")} AND EXISTS (
         SELECT 1 FROM function_refs mr WHERE mr.holder_node_id = ANY($${params.length}::uuid[]) AND mr.function_id = '${TASK_FUNCTION_ID}'
            AND mr.instance = '' AND NOT (mr.config ? 'source_tag_id')
       )))`,
    );
  }

  // Attribute filters: same shape. Case-insensitive value comparison so
  // "status:Done" matches the stored "done"; the key in NFC (the parser's
  // form, D58), so a key stored decomposed before D58 still filters.
  for (const attr of parsed.attrs) {
    params.push(attr.key);
    const keyIdx = params.length;
    params.push(attr.value);
    const valueIdx = params.length;
    where.push(
      `EXISTS (
         SELECT 1 FROM node_attributes na
         WHERE na.node_id = n.id
           AND normalize(na.key, NFC) = $${keyIdx}
           AND lower(na.value) = lower($${valueIdx})
       )`,
    );
  }

  // Read-policy push-down: bound the rows by the caller's COMBINED read set
  // (role/tag-policy visibility ∩ bearer-token tag scope) INSIDE the query, so
  // the LIMIT below applies to already-authorized rows — no post-fetch .filter()
  // that under-fills a low-rank caller's page. Same predicate (and equivalence
  // guard, readableScope.integration.test) as every other list endpoint. Pushed
  // before the LIMIT param so $${params.length} stays the LIMIT placeholder.
  where.push(readableScopeSql(actor, "n", params));

  // Snippet only meaningful when a text query landed; otherwise null so the
  // frontend doesn't render a useless empty snippet.
  //
  // CONTRACT (D76): the snippet is built here with the same snippetAround the
  // app's offline search uses, over the terms the engine matched (phrases
  // whole; OR / -excluded dropped). the extension's HTML snippet function is not used: it
  // returns HTML-escaped fragments (`&amp;`, `&lt;`) that the app showed
  // literally, over raw markdown.
  const snippetCols = text ? `, n.markdown AS snippet_body, ${text.keywords} AS snippet_terms` : ``;
  // Pure-filter queries have no relevance, so they order by recency.
  const orderExpr = text ? text.order : `n.updated_at DESC`;

  params.push(limit);
  const sql = `
    SELECT n.id, n.title, n.slug, n.node_type, NOT ${notATaskNodeSql("n")} AS is_task${snippetCols}
    FROM content_nodes n
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderExpr}
    LIMIT $${params.length}
  `;
  type Row = Omit<NodeSearchResult, "snippet"> & { snippet_body?: string | null; snippet_terms?: string[] | null };
  const result = await q<Row>(sql, params);
  return result.rows.map(({ snippet_body, snippet_terms, ...row }) => ({
    ...row,
    snippet: snippet_body && snippet_terms?.length ? snippetAround(snippet_body, snippet_terms) : null,
  }));
}
