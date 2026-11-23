// Wikilink edges — the `[[link]]` graph that backlinks (the app's inspector,
// the published site) read. One matching rule, applied from both sides: a
// note's save re-derives the edges OUT of it (syncWikilinkEdges), and a change
// to what names a note — its creation, title, slug, aliases, space, return
// from the trash — re-derives the edges INTO it (relinkTarget). Both write
// the rows raw, in the caller's transaction, with no event of their own. A
// leaf: spine/nodeHooks.ts calls it on an `aliases` change, so it imports
// nothing that reaches back there.

import { q, requireTransaction } from "../db.js";
import { db } from "../dbKysely.js";
import { linkIndexLookup, type LinkIndexRow } from "./linkIndexLookup.js";
import { sql } from "kysely";
import { extractWikilinks } from "../utils.js";
import { NODE_REF_PREFIX, linkSlug, normalizeText } from "@onden/markdown";
import { liveNodeSql, tagNodeSql } from "../spine/nodeSql.js";

/** The one rule a `[[link]]` names a node by, as SQL over the candidate
 *  target `n` and the linking note `s` (both content_nodes rows). `linksLc`
 *  and `linkSlugs` are SQL text[] expressions: the link targets as
 *  extractWikilinks reads them (NFC, wikilinkTarget), lowercased, and their
 *  linkSlug. A title or alias is compared in NFC too, so one stored
 *  decomposed (a macOS zip before D58) is still found. A link names
 *  a live node other than its source, in the source's space (tags are
 *  global), whose title (case-insensitive), slug or `aliases` attribute it
 *  is, or whose id the link spells (`onden://node/<id>`, @onden/markdown
 *  nodeRef). syncWikilinkEdges (the source's side) and relinkTarget (the target's
 *  side) both use it, so a backlink cannot depend on which side saved last.
 *  The app's resolveWikilink and the site's servedLinkTarget are separate
 *  implementations of the same rule; markdown fixtures/wikilinkTargets.json
 *  holds all three to the same answers (test/wikilinkTargets.integration.test.ts). */
function linkMatchesNodeSql(n: string, s: string, linksLc: string, linkSlugs: string): string {
  return `(${n}.id <> ${s}.id
    AND ${liveNodeSql(n)}
    -- [[title]] resolves within the source note's space (tags are global):
    -- a title in another space reads as if it did not exist.
    AND (${tagNodeSql(n)} OR ${n}.space_id IS NOT DISTINCT FROM ${s}.space_id)
    AND (
      lower(normalize(${n}.title, NFC)) = ANY(${linksLc})
      OR ${n}.slug = ANY(${linkSlugs})
      -- [[onden://node/<id>]]: a node named by id (a task has no slug and
      -- often a shared title). Hidden nodes count; the reader's own
      -- read check applies where the edge is read, as for any link.
      OR '${NODE_REF_PREFIX}' || ${n}.id::text = ANY(${linksLc})
      OR EXISTS (
        SELECT 1 FROM node_attributes a
         WHERE a.node_id = ${n}.id AND a.key = 'aliases'
           AND (
             -- Aliases are stored as a JSON array string (frontmatter import);
             -- match any element case-insensitively against the link targets.
             -- A non-array/scalar value (a single bare alias) is matched whole.
             (a.value LIKE '[%' AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(a.value::jsonb) alias
                WHERE lower(normalize(alias, NFC)) = ANY(${linksLc})
             ))
             OR (a.value NOT LIKE '[%' AND lower(normalize(a.value, NFC)) = ANY(${linksLc}))
           )
      )
    ))`;
}

const UPSERT_WIKILINK_EDGE = `INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin)
       VALUES ($1, $2, $3, 'knowledge_link', 'active', 'wikilink')
       ON CONFLICT (workspace_id, source_node_id, target_node_id, edge_type, origin)
       DO UPDATE SET status = 'active'`;

/** Record which link targets `markdown` names (note_link_index, migration 146)
 *  so relinkTarget can find the notes linking to a name without reading every
 *  text. Written only while `markdown` is the note's stored text: a row for
 *  any other text would hide a link from relinkTarget. */
async function indexNoteLinks(workspaceId: string, noteId: string, markdown: string, links: string[]) {
  await q(
    `INSERT INTO note_link_index (note_id, workspace_id, link_lc, link_slug, stale)
     SELECT n.id, n.workspace_id, $3::text[], $4::text[], false FROM content_nodes n
      WHERE n.id = $2 AND n.workspace_id = $1 AND n.markdown = $5
     ON CONFLICT (note_id) DO UPDATE SET link_lc = EXCLUDED.link_lc, link_slug = EXCLUDED.link_slug, stale = false`,
    [workspaceId, noteId, links.map((link) => link.toLowerCase()), links.map((link) => linkSlug(link)), markdown],
  );
}

/** Index the notes whose note_link_index row is stale (every note after
 *  migration 146). Until a note is indexed relinkTarget reads its text, so
 *  this only makes that faster; run once at start-up, in batches, outside any
 *  transaction. A note without a row (inserted with triggers off) gets one
 *  first. Returns how many notes were looked at. `workspaceId` limits the
 *  pass to one workspace (start-up passes none: every workspace). */
export async function indexMissingNoteLinks({ workspaceId, batchSize = 200 }: { workspaceId?: string; batchSize?: number } = {}): Promise<number> {
  await q(
    `INSERT INTO note_link_index (note_id, workspace_id)
     SELECT n.id, n.workspace_id FROM content_nodes n
      WHERE ($1::uuid IS NULL OR n.workspace_id = $1)
        AND NOT EXISTS (SELECT 1 FROM note_link_index i WHERE i.note_id = n.id)
     ON CONFLICT (note_id) DO NOTHING`,
    [workspaceId ?? null],
  );
  let after = "00000000-0000-0000-0000-000000000000";
  let seen = 0;
  for (;;) {
    const batch = await q<{ id: string; workspace_id: string; markdown: string }>(
      `SELECT s.id::text, s.workspace_id::text, s.markdown FROM note_link_index i JOIN content_nodes s ON s.id = i.note_id
        WHERE i.stale AND ${liveNodeSql("s")} AND s.id > $1 AND ($3::uuid IS NULL OR s.workspace_id = $3)
        ORDER BY s.id LIMIT $2`,
      [after, batchSize, workspaceId ?? null],
    );
    if (batch.rows.length === 0) return seen;
    for (const note of batch.rows) await indexNoteLinks(note.workspace_id, note.id, note.markdown, extractWikilinks(note.markdown));
    seen += batch.rows.length;
    after = batch.rows[batch.rows.length - 1]!.id;
  }
}

export async function syncWikilinkEdges(workspaceId: string, sourceNodeId: string, markdown: string) {
  requireTransaction("syncWikilinkEdges");
  const links = extractWikilinks(markdown);
  await indexNoteLinks(workspaceId, sourceNodeId, markdown, links);
  if (links.length === 0) {
    await q(
      "DELETE FROM node_edges WHERE workspace_id = $1 AND source_node_id = $2 AND origin = 'wikilink'",
      [workspaceId, sourceNodeId],
    );
    return [];
  }

  const targets = await q<{ id: string; title: string; slug: string }>(
    `SELECT n.id, n.title, n.slug
       FROM content_nodes n, content_nodes s
      WHERE s.id = $2 AND n.workspace_id = $1
        AND ${linkMatchesNodeSql("n", "s", "$3::text[]", "$4::text[]")}`,
    [
      workspaceId,
      sourceNodeId,
      links.map((link) => link.toLowerCase()),
      links.map((link) => linkSlug(link)),
    ],
  );

  // Keep surviving links' rows (and ids): sync clients identify edges by id, so
  // delete-all-then-reinsert churned every link on every save.
  await q(
    `DELETE FROM node_edges
      WHERE workspace_id = $1 AND source_node_id = $2 AND origin = 'wikilink'
        AND target_node_id <> ALL($3::uuid[])`,
    [workspaceId, sourceNodeId, targets.rows.map((target) => target.id)],
  );
  for (const target of targets.rows) {
    await q(UPSERT_WIKILINK_EDGE, [workspaceId, sourceNodeId, target.id]);
  }
  return targets.rows;
}

/** The live nodes each `[[target]]` in `targets` names when written in the
 *  note `sourceNodeId` — the same rule as its edges (linkMatchesNodeSql: its
 *  space, tags global; title, slug or alias). Keyed by the target as given;
 *  a target naming nothing is absent. Reads only: no edge is written, and
 *  whether the caller may read a named node is the caller's check. Used to
 *  turn an imported relation link back into an id (importedRelations.ts). */
export async function wikilinkTargets(workspaceId: string, sourceNodeId: string, targets: string[]): Promise<Map<string, string[]>> {
  const named = new Map<string, string[]>();
  if (targets.length === 0) return named;
  const rows = await q<{ link: string; id: string }>(
    `SELECT l.link, n.id::text AS id
       FROM unnest($3::text[], $4::text[], $5::text[]) AS l(link, link_lc, link_slug)
       JOIN content_nodes s ON s.workspace_id = $1 AND s.id = $2
       JOIN content_nodes n ON n.workspace_id = $1
      WHERE ${linkMatchesNodeSql("n", "s", "ARRAY[l.link_lc]", "ARRAY[l.link_slug]")}`,
    [workspaceId, sourceNodeId, targets, targets.map((t) => t.toLowerCase()), targets.map((t) => linkSlug(t))],
  );
  for (const row of rows.rows) named.set(row.link, [...(named.get(row.link) ?? []), row.id]);
  return named;
}

/** A target of relinkTarget, with the keys a link index row names it by (`lc`: its title, its node reference and its aliases, lower-cased in NFC; the same
 *  expressions syncWikilinkEdges' rows are compared with), its space and whether it is a tag. */
type RelinkTarget = { id: string; title: string; slug: string; aliases: string[]; lc: string[]; space_id: string | null; tag: boolean };


async function relinkTargets(workspaceId: string, nodeIds: readonly string[]): Promise<RelinkTarget[]> {
  return (await q<RelinkTarget>(
    `SELECT n.id::text, n.title, n.slug, ${nodeAliasesSql("n")} AS aliases, n.space_id::text, ${tagNodeSql("n")} AS tag,
            ARRAY[lower(normalize(n.title, NFC)), '${NODE_REF_PREFIX}' || n.id::text]
              || ARRAY(SELECT lower(normalize(x, NFC)) FROM unnest(${nodeAliasesSql("n")}) x) AS lc
       FROM content_nodes n
      WHERE n.workspace_id = $1 AND n.id = ANY($2::uuid[]) AND ${liveNodeSql("n")}
      ORDER BY n.id`,
    [workspaceId, [...nodeIds]],
  )).rows;
}

/** The up-to-date link index rows that name one of `targets`: one look-up by the targets' keys as constants, so the GIN indexes on link_lc / link_slug can answer
 *  it (a join of the index with the keys was planned as a scan of every row of the index and of the notes, for every batch: PR #1941 CI, anchorSaveCost). */
async function indexRowsNaming(workspaceId: string, targets: readonly RelinkTarget[]): Promise<LinkIndexRow[]> {
  if (targets.length === 0) return [];
  return db.selectFrom("note_link_index").select(["note_id", "link_lc", "link_slug"]).where("workspace_id", "=", workspaceId).where("stale", "=", false)
    .where(sql<boolean>`(link_lc && ${[...new Set(targets.flatMap((t) => t.lc))]}::text[] OR link_slug && ${[...new Set(targets.map((t) => t.slug))]}::text[])`)
    .orderBy("note_id").execute();
}

/** How many targets relinkTarget works out in one statement. */
const RELINK_BATCH = 50;

/** A character a link's target can hold (Postgres regex): a link body never
 *  holds `]` or a line break, and its target ends at the first `|` or `#`
 *  (@onden/markdown wikilinkTarget). */
const LINK_CHAR = String.raw`[^]\n|#]`;

/** A node's `aliases` attribute as a SQL text[] over the content_nodes row
 *  `n`: a JSON array string (frontmatter import) is read element by element,
 *  a bare value is one alias, no attribute is '{}'. relinkTarget and the
 *  published site's link redaction read aliases through this. */
export function nodeAliasesSql(n: string): string {
  return `COALESCE((SELECT CASE WHEN a.value LIKE '[%'
                              THEN ARRAY(SELECT jsonb_array_elements_text(a.value::jsonb))
                              ELSE ARRAY[a.value] END
                    FROM node_attributes a WHERE a.node_id = ${n}.id AND a.key = 'aliases'), '{}')`;
}

/** Reverse of syncWikilinkEdges: re-derive the wikilink edges INTO each of
 *  `nodeIds` from the notes that link to it now. Run after anything that
 *  changes what names a node or who may link to it: its creation, a title
 *  (and so slug) change, its `aliases`, a space move, a return from the
 *  trash. Edges materialize at the SOURCE's save, matched against the nodes
 *  of that moment, so without this a renamed note kept the backlinks of its
 *  old name and gained none from notes already linking its new one until
 *  those were saved again. In the caller's transaction; the edges are derived
 *  rows written raw, as syncWikilinkEdges writes them. A trashed target keeps
 *  its edges (it is skipped).
 *
 *  Candidates: the sources of the target's current incoming edges (to drop
 *  those that no longer name it), plus live notes in reach (its space, any
 *  space for a tag) whose links name it. For a note with a current
 *  note_link_index row that is an index lookup (the row holds the note's link
 *  targets as linkMatchesNodeSql compares them; a change to the text makes it
 *  stale). A note with a stale row is looked for in its text: holding `[[` and either
 *  (a) its title or an alias as a
 *  case-insensitive substring, or (b) its slug's letters and digits, in
 *  order, after one `[[` with only link-target characters between them. That
 *  is a superset of what linkMatchesNodeSql accepts, because a link target is
 *  a substring of the markdown: a title or alias match means the target,
 *  in NFC and lowercased, equals the name in NFC; a slug match means
 *  linkSlug(target) = slug, and linkSlug only normalises to NFC, lowercases,
 *  turns whitespace into `-` and drops what is not a letter, mark or digit,
 *  so the slug's characters occur in the target in that order with only
 *  target characters between (a slug that linkSlug would change can match no
 *  link and gets no pattern). The body is not normalised (D58), so a name or
 *  slug is looked for in both its NFC and its NFD spelling. Like the title
 *  rule itself, this takes Postgres lower() / ~* to fold case as
 *  JavaScript's toLowerCase does. The exact rule then runs in SQL. */
export async function relinkTarget(workspaceId: string, nodeIds: string[]): Promise<void> {
  requireTransaction("relinkTarget");
  if (nodeIds.length === 0) return;
  // Each target's edges are worked out on their own, so many targets are taken a batch at a time: with thousands in one statement (a change bundle that made
  // them, services/receivedDerivation.ts) the candidate query was planned over the whole array and ran past the statement timeout on a real Postgres
  // (stampedBundleScale.integration.test.ts). What does not depend on the batch is read ONCE for all of them: the targets themselves, the notes whose index row is stale (only
  // those that hold a `[[`), and the index rows that name any of the targets. A look-up of the index per batch was a scan of the whole index each time whenever the
  // planner judged the table small (it does at a few thousand rows, statistics or not), so the rows read grew with the square of the bundle (PR #1941 CI,
  // stampedBundleScale on a real Postgres).
  // Every other caller passes a handful and runs as one batch, as before.
  if (nodeIds.length > RELINK_BATCH) {
    const unread = (await db.selectFrom("note_link_index as i").innerJoin("content_nodes as s", "s.id", "i.note_id").select("i.note_id as id")
      .where("i.workspace_id", "=", workspaceId).where("i.stale", "=", true)
      .where(sql<boolean>`${sql.raw(liveNodeSql("s"))} AND strpos(s.markdown, '[[') > 0`).orderBy("i.note_id").execute()).map((r) => r.id);
    // In id order (relinkTargets), so the batches are the same on every node that takes the same bundle.
    const all = await relinkTargets(workspaceId, nodeIds);
    const index = linkIndexLookup(await indexRowsNaming(workspaceId, all));
    for (let i = 0; i < all.length; i += RELINK_BATCH) {
      const targets = all.slice(i, i + RELINK_BATCH);
      await relinkBatch(workspaceId, targets, index.notesNaming(targets), unread);
    }
    return;
  }
  const targets = await relinkTargets(workspaceId, nodeIds);
  if (targets.length === 0) return;
  await relinkBatch(workspaceId, targets, (await indexRowsNaming(workspaceId, targets)).map((row) => row.note_id));
}

/** relinkTarget for one batch of targets. `indexed`: the notes whose up-to-date index row names one of them (a superset is fine: what each candidate really links to is
 *  matched exactly below: linkMatchesNodeSql, the space, the liveness, the name). `unread`: the notes whose index row is stale and that hold a `[[`, when read once
 *  for every batch; absent, they are read here. */
async function relinkBatch(workspaceId: string, targets: readonly RelinkTarget[], indexed: readonly string[], unread?: readonly string[]): Promise<void> {
  requireTransaction("relinkBatch");
  const targetIds = targets.map((t) => t.id);

  const names: Array<[string, string]> = [];
  const patterns: Array<[string, string]> = [];
  for (const t of targets) {
    // A body may spell a name in either Unicode form (D58: bodies are not
    // rewritten), so each name and slug is looked for in NFC and in NFD.
    for (const name of [t.title, ...t.aliases]) {
      if (!name.trim()) continue;
      for (const form of new Set([normalizeText(name), name.normalize("NFD")])) names.push([t.id, form]);
    }
    if (t.slug && linkSlug(t.slug) === t.slug) {
      for (const form of new Set([t.slug, t.slug.normalize("NFD")])) {
        patterns.push([t.id, String.raw`\[\[` + `${LINK_CHAR}*` + [...form.replace(/-/g, "")].join(`${LINK_CHAR}*`)]);
      }
    }
  }
  const found = await q<{ id: string }>(
    `WITH unindexed AS MATERIALIZED (
       SELECT i.note_id AS id FROM note_link_index i JOIN content_nodes s ON s.id = i.note_id
        WHERE $7::uuid[] IS NULL AND i.workspace_id = $1 AND i.stale AND ${liveNodeSql("s")}
       UNION ALL SELECT unnest($7::uuid[])
     )
     -- Notes that link to a target now: they may have to lose the edge.
     SELECT e.source_node_id::text AS id FROM node_edges e
      WHERE e.workspace_id = $1 AND e.origin = 'wikilink' AND e.target_node_id = ANY($2::uuid[])
     UNION
     -- Indexed notes: the index says which names their text links to.
     SELECT unnest($8::uuid[])::text
     UNION
     -- A note whose index row is stale has not been read yet: look in its text.
     -- strpos, not LIKE '%[[%': the planner may answer a LIKE through the
     -- pgroonga text index, whose tokenizer reads "![[" as one token, so an
     -- embed-only note ("see ![[Name]]") was dropped whenever that plan won.
     SELECT s.id::text FROM unindexed u JOIN content_nodes s ON s.id = u.id
      WHERE strpos(s.markdown, '[[') > 0 AND EXISTS (
        SELECT 1 FROM unnest($2::uuid[], $9::uuid[], $10::boolean[]) t(id, space_id, tag)
         WHERE t.id <> s.id AND (t.tag OR t.space_id IS NOT DISTINCT FROM s.space_id)
           AND (EXISTS (SELECT 1 FROM unnest($3::uuid[], $4::text[]) k(target_id, name)
                         WHERE k.target_id = t.id AND strpos(lower(s.markdown), lower(k.name)) > 0)
                OR EXISTS (SELECT 1 FROM unnest($5::uuid[], $6::text[]) k(target_id, pattern)
                            WHERE k.target_id = t.id AND s.markdown ~* k.pattern)
                OR strpos(lower(s.markdown), '${NODE_REF_PREFIX}' || t.id::text) > 0))`,
    [workspaceId, targetIds, names.map(([id]) => id), names.map(([, name]) => name),
      patterns.map(([id]) => id), patterns.map(([, pattern]) => pattern), unread ?? null, indexed,
      targets.map((t) => t.space_id), targets.map((t) => t.tag)],
  );
  const candidates = { rows: found.rows.length === 0 ? [] : await db.selectFrom("content_nodes").select(["id", "markdown"])
    .where("workspace_id", "=", workspaceId).where("id", "in", found.rows.map((r) => r.id)).execute() };

  const linkSource: string[] = [];
  const linkLc: string[] = [];
  const linkSlugs: string[] = [];
  for (const cand of candidates.rows) {
    for (const link of extractWikilinks(cand.markdown ?? "")) {
      linkSource.push(cand.id);
      linkLc.push(link.toLowerCase());
      linkSlugs.push(linkSlug(link));
    }
  }
  const named = await q<{ source_id: string; target_id: string; live: boolean }>(
    `SELECT DISTINCT s.id::text AS source_id, n.id::text AS target_id, ${liveNodeSql("s")} AS live
       FROM unnest($2::uuid[], $3::text[], $4::text[]) AS l(source_id, link_lc, link_slug)
       JOIN content_nodes s ON s.id = l.source_id
       JOIN content_nodes n ON n.workspace_id = $1 AND n.id = ANY($5::uuid[])
      WHERE ${linkMatchesNodeSql("n", "s", "ARRAY[l.link_lc]", "ARRAY[l.link_slug]")}`,
    [workspaceId, linkSource, linkLc, linkSlugs, targetIds],
  );

  // Drop what no longer names its target; surviving rows keep their ids.
  await q(
    `DELETE FROM node_edges e
      WHERE e.workspace_id = $1 AND e.origin = 'wikilink' AND e.target_node_id = ANY($2::uuid[])
        AND NOT EXISTS (SELECT 1 FROM unnest($3::uuid[], $4::uuid[]) k(source_id, target_id)
                         WHERE k.source_id = e.source_node_id AND k.target_id = e.target_node_id)`,
    [workspaceId, targetIds, named.rows.map((r) => r.source_id), named.rows.map((r) => r.target_id)],
  );
  // A trashed source keeps the edges it still has and gains none; its own
  // syncWikilinkEdges runs when it comes back.
  for (const row of named.rows) {
    if (row.live) await q(UPSERT_WIKILINK_EDGE, [workspaceId, row.source_id, row.target_id]);
  }
}
