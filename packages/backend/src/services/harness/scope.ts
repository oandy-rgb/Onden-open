// What a run reads (its scope), gathered into numbered source blocks. Every
// note read here is bounded by the combined read set (role ∩ token scope)
// AND the space's external_ai switch, so a run can never become a read-policy
// bypass or send a note out of a space that keeps its notes local. System
// machinery (the Site Config note, the workspace-config tag) is never material:
// it is configuration, not a note, and must not reach a model.

import { decodeHtmlEntities, cutToUnits } from "@onden/markdown";
import { safeFetch } from "../safeFetch.js";
import { pool } from "../../db.js";
import { moduleRetrievalHits } from "../retrievalSources.js";
import { canReadNode, canSeeTag, readableNodeIdSet } from "../readPolicy.js";
import { findBoardNode, readCards, type BoardCard } from "../boardStore.js";
import { memberTagIds } from "../tagHierarchy.js";
import { filterByCapability } from "../../spine/spaceScope.js";
import { NOT_SYSTEM_NODE_SQL } from "../../spine/reservedNodes.js";
import type { ActorCtx } from "../../types.js";
import { liveNodeSql } from "../../spine/nodeSql.js";

/** A numbered source ([n] in a rendered prompt). */
export type Source = {
  n: number;
  kind: "node" | "web";
  id?: string;
  slug?: string;
  url?: string;
  title: string;
};

/** What a run reads. */
export type Scope =
  | { kind: "search"; query: string; limit?: number }
  | { kind: "text"; text: string }
  | { kind: "nodes"; ids: string[] }
  | { kind: "tag"; tagId: string }
  | { kind: "board"; boardId: string };

/** The scope can't be read: a tag the actor can't see, or no note in it they
 *  may send to the model. Routes answer 422 with the message. When the only
 *  obstacle is the spaces' external-AI switch, `reason` is "external_ai_off"
 *  and `spaceIds` names those spaces, so the UI can point at Settings › Spaces. */
export class ScopeUnavailable extends Error {
  readonly code = "scope_unavailable";
  constructor(message: string, readonly reason?: "external_ai_off", readonly spaceIds: string[] = []) {
    super(message);
    this.name = "ScopeUnavailable";
  }
}

const EXTERNAL_AI_OFF = "These notes are in a space whose external AI switch is off. Turn it on in Settings › Spaces to use AI on them.";

/** What the actor may read, and the part of it they may also send to a model.
 *  Both leave out system machinery by the rule /api/query and saved views list
 *  by (reservedNodes.NOT_SYSTEM_NODE_SQL), so every scope and the notes tools
 *  — which all read through this gate — skip it, and a system note in a
 *  local-only space never names that space as the reason. */
export async function aiReadable(workspaceId: string, actor: ActorCtx | null): Promise<{ readable: Set<string>; allowed: Set<string> }> {
  const system = new Set((await pool.query<{ id: string }>(
    `SELECT n.id::text FROM content_nodes n WHERE n.workspace_id = $1 AND NOT ${NOT_SYSTEM_NODE_SQL("n")}`,
    [workspaceId],
  )).rows.map((r) => r.id));
  const readable = new Set([...await readableNodeIdSet(actor, workspaceId)].filter((id) => !system.has(id)));
  return { readable, allowed: await filterByCapability(workspaceId, "external_ai", readable) };
}

/** The spaces of these notes (readable ones left out only by the external-AI switch). */
async function spacesOf(workspaceId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  return (await pool.query<{ space_id: string }>(
    `SELECT DISTINCT space_id::text FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND space_id IS NOT NULL`,
    [workspaceId, ids],
  )).rows.map((r) => r.space_id);
}

/** At most this many notes reach the model from a nodes or tag scope. */
const SCOPE_NOTE_LIMIT = 20;

/** The material gathered for a run: sources (for the citation list), the
 *  matching numbered blocks the model reads, and the spaces of readable notes
 *  that matched but were left out because external AI is off there. */
export type Gathered = { sources: Source[]; blocks: string[]; blockedSpaceIds?: string[] };

export const URL_RE = /https?:\/\/[^\s)\]>"']+/g;

/** Search scope: hybrid retrieval (exact terms, then semantic) over what the
 *  actor may read and send out, plus any page the question links to.
 *  `previousQuestion` keeps an anaphoric follow-up ("那第二點呢?") on topic;
 */
export async function gatherSearch(
  workspaceId: string,
  actor: ActorCtx | null,
  scope: { query: string; limit?: number },
  opts: { previousQuestion?: string } = {},
): Promise<Gathered> {
  const question = scope.query.trim();
  const limit = Math.min(scope.limit ?? 6, 12);
  const retrievalText = opts.previousQuestion ? `${opts.previousQuestion}\n${question}` : question;

  // Embeddings miss precise terms (a marker, a function name, a proper noun),
  // so exact-term matches come first, then semantic hits. Both are bounded by
  // the read set; only spaces with external_ai on may be sent to the model.
  const { readable: readableAll, allowed: readable } = await aiReadable(workspaceId, actor);
  const terms = retrievalTerms(retrievalText.replace(URL_RE, " "));
  const lexical = terms.length
    ? (await pool.query<{ id: string; title: string; slug: string }>(
        // Scoped to the read set before the LIMIT; notes matching more terms first.
        `SELECT id, title, slug FROM content_nodes
          WHERE workspace_id = $1 AND ${liveNodeSql()} AND node_type = 'content'
            AND id = ANY($4::uuid[])
            AND (title || ' ' || markdown) ILIKE ANY($2::text[])
          ORDER BY (SELECT count(*) FROM unnest($2::text[]) AS term WHERE (title || ' ' || markdown) ILIKE term) DESC,
                   updated_at DESC
          LIMIT $3`,
        [workspaceId, terms.map((t) => `%${t}%`), limit, [...readable]],
      )).rows
    : [];
  const semantic = await moduleRetrievalHits(workspaceId, retrievalText, { actor, limit: limit * 2 });
  const seen = new Set<string>();
  const visible = [...lexical, ...semantic]
    .filter((h) => readable.has(h.id) && !seen.has(h.id) && seen.add(h.id))
    .slice(0, limit);
  // Readable notes that match but stay out because external AI is off in
  // their space: never sent, only reported (where to turn it on).
  const held = [...readableAll].filter((id) => !readable.has(id));
  const blockedSpaceIds = terms.length && held.length
    ? (await pool.query<{ space_id: string }>(
        // Per held space, EXISTS stops at its first matching note — no
        // DISTINCT over every match in every held-back note.
        `SELECT s.space_id::text FROM (
            SELECT DISTINCT space_id FROM content_nodes
             WHERE workspace_id = $1 AND ${liveNodeSql()} AND node_type = 'content'
               AND id = ANY($3::uuid[]) AND space_id IS NOT NULL
          ) s
          WHERE EXISTS (
            SELECT 1 FROM content_nodes c
             WHERE c.workspace_id = $1 AND c.space_id = s.space_id AND ${liveNodeSql("c")}
               AND c.node_type = 'content' AND c.id = ANY($3::uuid[])
               AND (c.title || ' ' || c.markdown) ILIKE ANY($2::text[])
          )
          LIMIT 10`,
        [workspaceId, terms.map((t) => `%${t}%`), held],
      )).rows.map((r) => r.space_id)
    : [];

  const bodies = visible.length
    ? await pool.query<{ id: string; title: string; slug: string; markdown: string }>(
        `SELECT id, title, slug, markdown FROM content_nodes WHERE id = ANY($1::uuid[])`,
        [visible.map((h) => h.id)],
      )
    : { rows: [] as Array<{ id: string; title: string; slug: string; markdown: string }> };
  const bodyById = new Map(bodies.rows.map((r) => [r.id, r]));

  // Any URL the user put in the question is explicit context.
  const urls = [...new Set(question.match(URL_RE) ?? [])].slice(0, 2);
  const pages = (await Promise.all(urls.map(async (url) => ({ url, page: await fetchWebSource(url) }))))
    .filter((w): w is { url: string; page: { title: string; text: string } } => w.page !== null);

  const sources: Source[] = [];
  const blocks: string[] = [];
  for (const h of visible) {
    const body = bodyById.get(h.id);
    if (!body) continue;
    const n = sources.length + 1;
    sources.push({ n, kind: "node", id: h.id, slug: h.slug, title: h.title });
    blocks.push(`[${n}] "${body.title}" (note)\n${cutToUnits(body.markdown, 4_000)}`);
  }
  for (const w of pages) {
    const n = sources.length + 1;
    sources.push({ n, kind: "web", url: w.url, title: w.page.title });
    blocks.push(`[${n}] "${w.page.title}" (web: ${w.url})\n${w.page.text}`);
  }
  return { sources, blocks, ...(blockedSpaceIds.length ? { blockedSpaceIds } : {}) };
}

/** The notes the actor may read AND send out (external_ai), as numbered
 *  sources in the given order. */
async function numberedNotes(workspaceId: string, actor: ActorCtx | null, ids: string[]): Promise<Gathered> {
  const { readable: readableAll, allowed: readable } = await aiReadable(workspaceId, actor);
  const allowed = ids.filter((id) => readable.has(id)).slice(0, SCOPE_NOTE_LIMIT);
  const blockedSpaceIds = await spacesOf(workspaceId, ids.filter((id) => readableAll.has(id) && !readable.has(id)));
  const rows = allowed.length
    ? (await pool.query<{ id: string; title: string; slug: string; markdown: string }>(
        `SELECT id::text, title, slug, markdown FROM content_nodes
          WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND ${liveNodeSql()}`,
        [workspaceId, allowed],
      )).rows
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sources: Source[] = [];
  const blocks: string[] = [];
  for (const id of allowed) {
    const row = byId.get(id);
    if (!row) continue;
    const n = sources.length + 1;
    sources.push({ n, kind: "node", id: row.id, slug: row.slug, title: row.title });
    blocks.push(`[${n}] "${row.title}" (note)\n${cutToUnits(row.markdown, 4_000)}`);
  }
  return { sources, blocks, ...(blockedSpaceIds.length ? { blockedSpaceIds } : {}) };
}

/** None of the scope's notes could be sent: say whether the external-AI
 *  switch is why (and where), or give the plain reason. */
function nothingToSend(gathered: Gathered, plain: string): ScopeUnavailable {
  return gathered.blockedSpaceIds?.length
    ? new ScopeUnavailable(EXTERNAL_AI_OFF, "external_ai_off", gathered.blockedSpaceIds)
    : new ScopeUnavailable(plain);
}

/** Nodes scope: exactly these notes (unreadable or local-only ones are left
 *  out; none left is ScopeUnavailable). */
export async function gatherNodes(workspaceId: string, actor: ActorCtx | null, scope: { ids: string[] }): Promise<Gathered> {
  const gathered = await numberedNotes(workspaceId, actor, [...new Set(scope.ids)]);
  if (!gathered.sources.length) throw nothingToSend(gathered, "None of these notes can be read.");
  return gathered;
}

/** Tag scope: the most recently edited notes under the tag — the tag page's
 *  notes (tagHierarchy.memberTagIds: the tag, its child tags and the tags
 *  extending it). System machinery is left out here too (the gate drops it
 *  anyway), so it never takes one of the LIMIT's places. */
export async function gatherTag(workspaceId: string, actor: ActorCtx | null, scope: { tagId: string }): Promise<Gathered> {
  if (!actor || !(await canSeeTag(actor, scope.tagId))) throw new ScopeUnavailable("No such tag.");
  const gathered = await numberedNotes(workspaceId, actor, await tagMemberNoteIds(workspaceId, scope.tagId));
  if (!gathered.sources.length) throw nothingToSend(gathered, "No note under this tag can be read.");
  return gathered;
}

/** The tag page's notes, most recently edited first (up to 500; the read gate comes after). */
export async function tagMemberNoteIds(workspaceId: string, tagId: string): Promise<string[]> {
  const tags = await memberTagIds(workspaceId, tagId);
  return (await pool.query<{ id: string }>(
    `SELECT n.id::text FROM content_nodes n
      WHERE n.workspace_id = $1 AND ${liveNodeSql("n")} AND n.node_type = 'content' AND ${NOT_SYSTEM_NODE_SQL("n")}
        AND EXISTS (SELECT 1 FROM node_tags nt WHERE nt.node_id = n.id AND nt.tag_id = ANY($2::uuid[]))
      ORDER BY n.updated_at DESC
      LIMIT 500`,
    [workspaceId, tags],
  )).rows.map((r) => r.id);
}

/** A board's reading order: top to bottom, and left to right within a row.
 *  Rows are formed first (a card joins the current row while its top is
 *  within ROW of the row's first card), then each row is sorted by x — a
 *  pairwise "same row?" comparator is not transitive, so staggered cards
 *  would come out in input order. */
export function readingOrder(cards: Pick<BoardCard, "nodeId" | "x" | "y">[]): string[] {
  const ROW = 120;
  const rows: Array<Array<Pick<BoardCard, "nodeId" | "x" | "y">>> = [];
  for (const card of [...cards].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows[rows.length - 1];
    if (row && card.y - row[0]!.y < ROW) row.push(card);
    else rows.push([card]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x).map((c) => c.nodeId));
}

/** Board scope: a whiteboard's (or a tag board's) cards, in reading order —
 *  the order on the board is the order of the content. Only cards the actor
 *  can read are listed (boardStore.readCards), then the external-AI filter. */
export async function gatherBoard(workspaceId: string, actor: ActorCtx | null, scope: { boardId: string }): Promise<Gathered> {
  const board = await findBoardNode(workspaceId, scope.boardId);
  if (!actor || !board || !(await canReadNode(actor, scope.boardId))) throw new ScopeUnavailable("No such board.");
  const ids = readingOrder(await readCards(actor, workspaceId, scope.boardId));
  const gathered = await numberedNotes(workspaceId, actor, ids);
  if (!gathered.sources.length) throw nothingToSend(gathered, "No card on this board can be read.");
  return gathered;
}

/** Text scope: the selection itself is the only material (no sources). */
export function gatherText(scope: { text: string }): Gathered {
  return { sources: [], blocks: [cutToUnits(scope.text, 8_000)] };
}

function stripHtml(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const text = decodeHtmlEntities(html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return { title, text };
}

/** A page as plain text (≤ 8,000 chars), or null when it can't be read.
 *  SSRF-hardened through safeFetch. */
export async function fetchWebSource(url: string): Promise<{ title: string; text: string } | null> {
  try {
    // SSRF-hardened (audit #2): the url comes straight from the user's prompt.
    const res = await safeFetch(url, { timeoutMs: 8_000, maxBytes: 2 * 1024 * 1024, headers: { "user-agent": "onden-ask/1.0" } });
    if (res.status < 200 || res.status >= 300) return null;
    const { title, text } = stripHtml(cutToUnits(res.text, 400_000));
    if (!text) return null;
    return { title: title || url, text: cutToUnits(text, 8_000) };
  } catch {
    return null;
  }
}

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu;

/** Literal terms for the lexical leg: words of 5+ letters/digits (a marker,
 *  a function name) and, since Chinese and Japanese have no spaces, every
 *  2-character window of a CJK run ("深模組" → 深模, 模組). At most 10. */
export function retrievalTerms(text: string): string[] {
  const words = text.replace(CJK_RUN, " ").match(/[\p{L}\p{N}-]{5,}/gu) ?? [];
  const bigrams: string[] = [];
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) bigrams.push(run.slice(i, i + 2));
  }
  return [...new Set([...words, ...bigrams])].slice(0, 10);
}
