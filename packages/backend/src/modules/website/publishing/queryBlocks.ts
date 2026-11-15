// Query blocks frozen for readers (D113, the user's decision): when a note is
// published, each `onden-query` / `onden-base` block in it is evaluated ONCE
// and its result saved as a static list on the note (`query_blocks` in the
// snapshot payload), listing only notes that are themselves published. The
// HTML exports use the same rule: the zip carries the snapshot's lists, and a
// single-note export evaluates at export time, listing only notes on the
// served site. The site never runs a query (@onden/markdown queryBlocks.ts).
//
// The ONE evaluation for both, freezeQueryBlocks:
//   - onden-query: the block parsed as the app parses it (parseQuerySpec),
//     run by the app's own executor (nodeQuery.runNodeQuery — the shared
//     filter compiler, the read policy) as `actor`, restricted to the listed
//     pages (pushed down, so the block's limit counts listed notes only);
//   - onden-base: the app's evaluator (@onden/markdown basesEval, the same
//     file the app runs) over the listed notes `actor` can read, with the
//     server's data for what the app reads from its store: tag membership
//     (tagHierarchy.memberTagIdsNamed, as /api/query), the stored attribute
//     types (node_attributes.value_type) and the wikilink naming rule
//     (linkNamesNote, in the linking note's space, tags global). Event
//     predicates (file.modifiedBy / file.lastActor) are false here: who
//     edited a note is not the reader's to see.
// Rows carry the listed page's id, title and served slug; nothing else of a
// note leaves, except the columns an onden-base table asks for.

import {
  FROZEN_ROWS_MAX, applyView, baseTableColumns, baseTagNames, isTitleColumn, linkNamesNote, parseBaseSpec,
  parseQuerySpec, queryBlocksIn, wikilinkBodies,
  type AttributeValueType, type BaseEvalNode, type FrozenQueryBlock, type FrozenQueryRow, type ParsedQuery,
} from "@onden/markdown";
import { q } from "../../../db.js";
import type { ActorCtx } from "../../../types.js";
import { nodeQuerySchema, runNodeQuery } from "../../../services/nodeQuery.js";
import { readableScopeSql } from "../../../services/readPolicy.js";
import { LISTED_NODE_SQL } from "../../../spine/reservedNodes.js";
import { memberTagIdsNamed } from "../../../services/tagHierarchy.js";
import { nodeAliasesSql } from "../../../services/wikilinkEdges.js";
import { inertUnpublishedWikilinks, publishedAliases, publishedNames, type PublishedName } from "./redaction.js";
import { liveTagNodeSql } from "../../../spine/nodeSql.js";
import { isTag } from "@onden/markdown/contract";

/** A page a frozen list may name and link: its id, title and slug as the
 *  site serves them. */
export type ListedPage = { id: string; title: string; slug: string };

/** The frozen result of every onden-query / onden-base block in each of
 *  `notes`, keyed by note id (a note without such a block is absent).
 *  Evaluated as `actor` (null: an anonymous reader, who lists nothing) and
 *  listing only `listed` — the published pages for a publish, the served
 *  site's pages for an export. Read-only. */
export async function freezeQueryBlocks(
  workspaceId: string,
  notes: ReadonlyArray<{ id: string; title: string; markdown: string }>,
  scope: { actor: ActorCtx | null; listed: readonly ListedPage[] },
): Promise<Map<string, FrozenQueryBlock[]>> {
  const out = new Map<string, FrozenQueryBlock[]>();
  const listed = new Map(scope.listed.map((p) => [p.id, p]));
  const ids = [...listed.keys()];
  // What a frozen cell or block label may still name: the listed pages only (redaction.ts).
  let names: PublishedName[] | null = null;
  const listedNames = async () => names ??= publishedNames(scope.listed, await publishedAliases(ids));
  let baseData: Promise<BaseData> | null = null;
  for (const note of notes) {
    const blocks = queryBlocksIn(note.markdown);
    if (blocks.length === 0) continue;
    const frozen: FrozenQueryBlock[] = [];
    for (const { lang, source } of blocks) {
      if (lang === "onden-query") {
        frozen.push({ lang, source, columns: [], ...await frozenQuery(workspaceId, source, scope.actor, ids, listed, await listedNames()) });
      } else {
        baseData ??= loadBaseData(workspaceId, scope.actor, ids);
        frozen.push({ lang, source, ...await frozenBase(workspaceId, source, note.title, await baseData, listed, await listedNames()) });
      }
    }
    out.set(note.id, frozen);
  }
  return out;
}

type Frozen = Pick<FrozenQueryBlock, "rows" | "more" | "problem">;

/** What the app shows for a block it can't read (OndenQueryBlock). */
function queryProblem(parsed: Extract<ParsedQuery, { ok: false }>): string {
  switch (parsed.problem) {
    case "unknown_key": return `Unknown query key “${parsed.detail}”. Use tags, where, sort, limit or offset.`;
    case "bad_number": return `“${parsed.detail}” needs a whole number.`;
    case "unreadable_line": return `Can't read this query line: ${parsed.detail}`;
  }
}

async function frozenQuery(
  workspaceId: string, source: string, actor: ActorCtx | null, ids: string[], listed: ReadonlyMap<string, ListedPage>,
  names: readonly PublishedName[],
): Promise<Frozen> {
  const parsed = parseQuerySpec(source);
  if (!parsed.ok) return { rows: [], more: 0, problem: queryProblem(parsed) };
  const spec = nodeQuerySchema.safeParse(parsed.spec);
  if (!spec.success) return { rows: [], more: 0, problem: "This query can't be read." };
  if (ids.length === 0) return { rows: [], more: 0 };
  // The block's own page size (the app's default 50), never above the bound.
  const limit = Math.min(spec.data.limit ?? 50, FROZEN_ROWS_MAX);
  const result = await runNodeQuery(actor, workspaceId, { ...spec.data, limit }, { within: ids });
  const rows: FrozenQueryRow[] = [];
  for (const row of result.rows) {
    const page = listed.get(row.id);
    if (!page) continue;
    // A block's row names the block, under its note's page; its label is the block's text as typed.
    rows.push("block" in row ? { id: page.id, title: inertUnpublishedWikilinks(row.block.label, names), slug: page.slug, note: page.title } : { id: page.id, title: page.title, slug: page.slug });
  }
  return { rows, more: Math.max(0, result.total - result.rows.length) };
}

type LinkTarget = { id: string; title: string; slug: string; node_type: string; space_id: string | null; aliases: string[] };
type BaseNode = BaseEvalNode & { space_id: string | null };
type BaseData = { nodes: BaseNode[]; targets: LinkTarget[] };

/** The listed notes `actor` can read, as the evaluator reads a note, and
 *  every node `actor` can read as a link target (what a [[name]] names). */
async function loadBaseData(workspaceId: string, actor: ActorCtx | null, ids: string[]): Promise<BaseData> {
  const params: unknown[] = [workspaceId, ids];
  const nodes = await q<{
    id: string; title: string; markdown: string; node_type: string; space_id: string | null; source_type: string | null;
    updated_at: Date | string | null; tag_ids: string[]; attrs: Record<string, string>; value_types: Record<string, AttributeValueType>;
  }>(
    `SELECT cn.id::text, cn.title, cn.markdown, cn.node_type, cn.space_id::text, cn.source_type, cn.updated_at,
            COALESCE((SELECT array_agg(t.id::text) FROM node_tags nt
                        JOIN content_nodes t ON t.id = nt.tag_id AND ${liveTagNodeSql("t")}
                       WHERE nt.node_id = cn.id), '{}') AS tag_ids,
            COALESCE((SELECT jsonb_object_agg(na.key, na.value) FROM node_attributes na WHERE na.node_id = cn.id), '{}'::jsonb) AS attrs,
            COALESCE((SELECT jsonb_object_agg(na.key, na.value_type) FROM node_attributes na WHERE na.node_id = cn.id), '{}'::jsonb) AS value_types
       FROM content_nodes cn
      WHERE cn.workspace_id = $1 AND cn.id = ANY($2::uuid[]) AND cn.node_type = 'content' AND cn.hidden = false
        AND ${LISTED_NODE_SQL("cn")} AND ${readableScopeSql(actor, "cn", params)}
      ORDER BY cn.created_at ASC, cn.id ASC`,
    params,
  );
  const targetParams: unknown[] = [workspaceId];
  const targets = await q<LinkTarget>(
    `SELECT cn.id::text, cn.title, cn.slug, cn.node_type, cn.space_id::text, ${nodeAliasesSql("cn")} AS aliases
       FROM content_nodes cn
      WHERE cn.workspace_id = $1 AND ${readableScopeSql(actor, "cn", targetParams)}`,
    targetParams,
  );
  return {
    nodes: nodes.rows.map((n) => ({
      id: n.id, title: n.title, markdown: n.markdown, node_type: n.node_type, space_id: n.space_id,
      source_type: n.source_type ?? undefined, tag_ids: n.tag_ids, frontmatter: n.attrs, value_types: n.value_types,
      last_modified_at: n.updated_at == null ? undefined : new Date(n.updated_at).toISOString(),
    })),
    targets: targets.rows,
  };
}

async function frozenBase(
  workspaceId: string, source: string, hostTitle: string, data: BaseData, listed: ReadonlyMap<string, ListedPage>,
  names: readonly PublishedName[],
): Promise<Pick<FrozenQueryBlock, "columns"> & Frozen> {
  let spec;
  try {
    spec = parseBaseSpec(source);
  } catch (e) {
    return { columns: [], rows: [], more: 0, problem: `Base parse error: ${(e as Error).message}` };
  }
  const view = spec.views[0];
  if (!view) return { columns: [], rows: [], more: 0, problem: "No views defined." };
  // The block is embedded in its host note: `this` is the host's title, as
  // in the app (OndenBaseBlock).
  const thisTitle = hostTitle || undefined;
  const members = new Map<string, ReadonlySet<string>>();
  for (const name of baseTagNames(spec, view, thisTitle)) {
    members.set(name.toLowerCase(), new Set(await memberTagIdsNamed(workspaceId, [name])));
  }
  const nameTargets = new Map<string, LinkTarget[]>();
  const named = (name: string) => {
    let found = nameTargets.get(name);
    if (!found) {
      found = data.targets.filter((t) => linkNamesNote(name, t));
      nameTargets.set(name, found);
    }
    return found;
  };
  // The app's file.hasLink (frontend lib/basesEval.ts linksTo over
  // lib/wikilinks.ts wikilinkReaches): a [[title]] reaches a note in the
  // linking note's space, a tag anywhere; a dangling link names by title.
  const reaches = (body: string, from: BaseNode, t: LinkTarget) =>
    linkNamesNote(body, t) && (isTag(t) || t.space_id === from.space_id);
  const rows = applyView(data.nodes, spec, view, {
    thisTitle,
    tagMembers: (name) => members.get(name.toLowerCase()) ?? new Set(),
    linksTo: (node, name) => {
      const from = node as BaseNode;
      if (!from.markdown.includes("[[")) return false;
      const targets = named(name);
      const dangling = !targets.some((t) => reaches(name, from, t));
      return wikilinkBodies(from.markdown).some((body) =>
        targets.some((t) => reaches(body, from, t)) || (dangling && linkNamesNote(body, { title: name })));
    },
  });
  // A table shows its `order` keys as columns (BasesTable); a list or cards
  // view, the titles.
  const columns = view.type === "table"
    ? baseTableColumns(view).filter((key) => !isTitleColumn(key)) : [];
  const shown = rows.slice(0, FROZEN_ROWS_MAX).flatMap((n): FrozenQueryRow[] => {
    const page = listed.get(n.id);
    if (!page) return [];
    return [{
      id: page.id, title: page.title, slug: page.slug,
      ...(columns.length ? { values: columns.map((key) => inertUnpublishedWikilinks(String(n.frontmatter?.[key] ?? ""), names)) } : {}),
    }];
  });
  return { columns, rows: shown, more: Math.max(0, rows.length - FROZEN_ROWS_MAX) };
}
