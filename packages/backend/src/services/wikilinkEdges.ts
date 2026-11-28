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
import { sql, type RawBuilder, type Selectable } from "kysely";
import { extractWikilinks } from "../utils.js";
import { NODE_REF_PREFIX, isUuid, linkSlug, normalizeText } from "@onden/markdown";
import { NO_SPACE, liveNodeSql, tagNodeSql } from "../spine/nodeSql.js";
import type { ContentNodes } from "../dbSchema.generated.js";

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
      OR EXISTS (SELECT 1 FROM node_attributes a WHERE a.node_id = ${n}.id AND a.key = 'aliases' AND ${aliasNamedSql("a", linksLc)})
    ))`;
}

/** The `aliases` attribute row `a` holds one of the link targets `linksLc` (linkMatchesNodeSql's alias rule). Aliases are stored as a JSON array string
 *  (frontmatter import): any element matches, case-insensitively in NFC; a non-array value (a single bare alias) is matched whole. */
function aliasNamedSql(a: string, linksLc: string): string {
  return `((${a}.value LIKE '[%' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${a}.value::jsonb) alias WHERE lower(normalize(alias, NFC)) = ANY(${linksLc})))
           OR (${a}.value NOT LIKE '[%' AND lower(normalize(${a}.value, NFC)) = ANY(${linksLc})))`;
}

/** The columns of a note the link look-ups read, and all notesWithIdsSql gives (never a row a client gets). */
const NOTE_COLUMNS = "id, workspace_id, title, slug, markdown, space_id, node_type, deleted_at, hidden";
type NoteColumns = Pick<Selectable<ContentNodes>, "id" | "workspace_id" | "title" | "slug" | "markdown" | "space_id" | "node_type" | "deleted_at" | "hidden">;

/** The notes whose id is in the SQL uuid[] expression `ids` (each once; NOTE_COLUMNS), as a FROM item read by the primary key, one look-up an id, whatever else
 *  the query says and whatever the planner thinks of the table's size. An id list next to other conditions (`workspace_id = … AND id = ANY(…)`) was planned as a
 *  read of every note of the workspace whenever the planner judged the table small (a few thousand rows, statistics new or not: issue #2021), and so was
 *  `id = ANY(…)` alone for a list of a few hundred ids (it costs a scan below that many look-ups). Here each id is its own look-up (a LATERAL subquery that
 *  OFFSET 0 keeps from being merged into a join), so the only plans left are a key look-up an id or, for a table of a page or two, a read of it an id; conditions
 *  written outside are applied to the rows found, never pushed into the look-up. */
function notesWithIdsSql(ids: string): string {
  return `${NOTES_WITH_IDS_BEFORE}${ids}${NOTES_WITH_IDS_AFTER}`;
}
/** notesWithIdsSql for a kysely query, `ids` as one parameter. Example: db.selectFrom(notesWithIds(ids).as("n")).select(["n.id", "n.title"]). Also the
 *  received derivation's read of the notes a bundle names (receivedDerivation.ts notesAsTheyAre). */
export function notesWithIds(ids: readonly string[]): RawBuilder<NoteColumns> {
  return sql<NoteColumns>`${sql.raw(NOTES_WITH_IDS_BEFORE)}${[...ids]}::uuid[]${sql.raw(NOTES_WITH_IDS_AFTER)}`;
}
/** The one text of notesWithIdsSql, before and after the uuid[] it reads: both spellings put their ids between (a SQL expression, notesWithIdsSql; a kysely
 *  parameter, notesWithIds). */
const NOTES_WITH_IDS_BEFORE = "(SELECT c.* FROM (SELECT DISTINCT unnest(";
const NOTES_WITH_IDS_AFTER = `) AS id) k CROSS JOIN LATERAL (SELECT ${NOTE_COLUMNS} FROM content_nodes WHERE id = k.id OFFSET 0) c)`;

/** How many characters of a title, lower-cased in NFC, its index key holds (migration 241 content_nodes_title_key_idx; the migration says why it is cut). */
const TITLE_KEY_CHARS = 500;
/** The key of the title index over the SQL text expression `lowered` (a title or a link target, lower-cased in NFC): spelled as the index is, so it answers it. */
const titleKeySql = (lowered: string): string => `left(${lowered}, ${TITLE_KEY_CHARS})`;

/** The live nodes that may be what a link of `linksLc` / `linkSlugs` names (SQL text[] expressions, as linkMatchesNodeSql takes them), written in a
 *  note of the space `sourceSpace` (a SQL uuid expression), as a FROM item (notesWithIdsSql); `refIds` (SQL uuid[]): the ids its `onden://node/<id>` links spell (nodeRefIds). Each
 *  rule of linkMatchesNodeSql through an index, so what is read grows with the nodes the links name, never with the workspace (issue #2021: as one join with
 *  the rule every live note of the workspace was read for each note saved with a link, each file imported with links, each note moved or restored):
 *    a title:  the title index (migration 241), on its cut key: equal titles have equal keys, so every title the rule accepts is found;
 *    a slug:   the unique slug index (its key `COALESCE(space_id, NO_SPACE)`), in the source's space or in none: the rule's "its space, or a tag" (a tag
 *              has no space: content_nodes_derive_space);
 *    an id:    the ids themselves (the exact rule below drops one that is no live node of the workspace);
 *    an alias: the `aliases` attributes of the workspace (node_attributes_key_idx): the nodes that have aliases, not all of them.
 *  A superset: the caller applies linkMatchesNodeSql to these (through notesWithIdsSql), which decides. */
function linkCandidatesSql(ws: string, sourceSpace: string, linksLc: string, linkSlugs: string, refIds: string): string {
  return notesWithIdsSql(`ARRAY(SELECT c.id FROM content_nodes c WHERE c.workspace_id = ${ws} AND ${liveNodeSql("c")}
            AND ${titleKeySql("lower(normalize(c.title, NFC))")} = ANY(ARRAY(SELECT ${titleKeySql("x")} FROM unnest(${linksLc}) x))
    UNION SELECT c.id FROM content_nodes c WHERE c.workspace_id = ${ws} AND ${liveNodeSql("c")}
            AND COALESCE(c.space_id, '${NO_SPACE}'::uuid) = ANY(ARRAY[COALESCE(${sourceSpace}, '${NO_SPACE}'::uuid), '${NO_SPACE}'::uuid]) AND c.slug = ANY(${linkSlugs})
    UNION SELECT unnest(${refIds})
    UNION SELECT a.node_id FROM node_attributes a WHERE a.workspace_id = ${ws} AND a.key = 'aliases' AND ${aliasNamedSql("a", linksLc)})`);
}

/** The ids the `onden://node/<id>` links among `linksLc` (lower-cased link targets) spell: what linkMatchesNodeSql's id rule can accept. */
const nodeRefIds = (linksLc: readonly string[]): string[] =>
  [...new Set(linksLc.filter((l) => l.startsWith(NODE_REF_PREFIX)).map((l) => l.slice(NODE_REF_PREFIX.length)).filter(isUuid))];

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

  const linksLc = links.map((link) => link.toLowerCase());
  const targets = await q<{ id: string; title: string; slug: string }>(
    `SELECT n.id, n.title, n.slug
       FROM ${linkCandidatesSql("$1", "(SELECT space_id FROM content_nodes WHERE id = $2)", "$3::text[]", "$4::text[]", "$5::uuid[]")} n,
            content_nodes s
      WHERE s.id = $2 AND n.workspace_id = $1
        AND ${linkMatchesNodeSql("n", "s", "$3::text[]", "$4::text[]")}`,
    [workspaceId, sourceNodeId, linksLc, links.map((link) => linkSlug(link)), nodeRefIds(linksLc)],
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
  const targetsLc = targets.map((t) => t.toLowerCase());
  const rows = await q<{ link: string; id: string }>(
    `SELECT l.link, n.id::text AS id
       FROM unnest($3::text[], $4::text[], $5::text[]) AS l(link, link_lc, link_slug)
       JOIN content_nodes s ON s.workspace_id = $1 AND s.id = $2
       JOIN ${linkCandidatesSql("$1", "(SELECT space_id FROM content_nodes WHERE id = $2)", "$4::text[]", "$5::text[]", "$6::uuid[]")} n
         ON n.workspace_id = $1
      WHERE ${linkMatchesNodeSql("n", "s", "ARRAY[l.link_lc]", "ARRAY[l.link_slug]")}`,
    [workspaceId, sourceNodeId, targets, targetsLc, targets.map((t) => linkSlug(t)), nodeRefIds(targetsLc)],
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
       FROM ${notesWithIdsSql("$2::uuid[]")} n
      WHERE n.workspace_id = $1 AND ${liveNodeSql("n")}
      ORDER BY n.id`,
    [workspaceId, [...nodeIds]],
  )).rows;
}

/** The up-to-date link index rows that name one of `targets`: one look-up by the targets' keys as constants, so the GIN indexes on link_lc / link_slug can answer
 *  it (a join of the index with the keys was planned as a scan of every row of the index and of the notes, for every batch: PR #1941 CI, anchorSaveCost). */
async function indexRowsNaming(workspaceId: string, targets: readonly RelinkTarget[]): Promise<LinkIndexRow[]> {
  if (targets.length === 0) return [];
  // Sorted here, not by an ORDER BY: one was planned as a walk of the whole primary key, every row of the index, to save a sort (issue #2021).
  return (await db.selectFrom("note_link_index").select(["note_id", "link_lc", "link_slug"]).where("workspace_id", "=", workspaceId).where("stale", "=", false)
    .where(sql<boolean>`(link_lc && ${[...new Set(targets.flatMap((t) => t.lc))]}::text[] OR link_slug && ${[...new Set(targets.map((t) => t.slug))]}::text[])`)
    .execute()).sort((x, y) => (x.note_id < y.note_id ? -1 : x.note_id > y.note_id ? 1 : 0));
}

/** The live notes whose link index row is stale and whose text holds a `[[`: the ones relinkTarget looks for a name in by their text. The stale rows first
 *  (their partial index), then those notes by id: one join of the two was planned as a read of every live note of the workspace (issue #2021). */
async function staleNotesWithLinks(workspaceId: string): Promise<string[]> {
  const stale = (await db.selectFrom("note_link_index").select("note_id").where("workspace_id", "=", workspaceId).where("stale", "=", true).execute()).map((r) => r.note_id);
  if (stale.length === 0) return [];
  // one array, not a parameter a note: every note is stale after migration 146 until the start-up pass indexes it, more than a statement takes parameters
  return (await db.selectFrom(notesWithIds(stale).as("s")).select("s.id")
    .where(sql<boolean>`${sql.raw(liveNodeSql("s"))} AND strpos(s.markdown, '[[') > 0`).orderBy("s.id").execute()).map((r) => r.id);
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
  // those that hold a `[[`), the index rows that name any of the targets, and the wikilink edges into them. A look-up of the index, or of the edges, per batch was a
  // scan of the whole table each time whenever the planner judged it small (it does at a few thousand rows, statistics or not: rightly, for one look-up), so the
  // rows read grew with the square of the bundle (PR #1941 CI, stampedBundleScale on a real Postgres; the edges: issue #2021, receivedRelinkCost). A batch only
  // writes the edges into its own targets, so what was read before the first batch is still what each later one finds.
  // Every other caller passes a handful and runs as one batch, as before.
  if (nodeIds.length > RELINK_BATCH) {
    const unread = await staleNotesWithLinks(workspaceId);
    // In id order (relinkTargets), so the batches are the same on every node that takes the same bundle.
    const all = await relinkTargets(workspaceId, nodeIds);
    const index = linkIndexLookup(await indexRowsNaming(workspaceId, all));
    const into = await edgesInto(workspaceId, all.map((t) => t.id));
    for (let i = 0; i < all.length; i += RELINK_BATCH) {
      const targets = all.slice(i, i + RELINK_BATCH);
      const ids = new Set(targets.map((t) => t.id));
      await relinkBatch(workspaceId, targets, index.notesNaming(targets), unread, into.filter((e) => ids.has(e.target_node_id)));
    }
    return;
  }
  const targets = await relinkTargets(workspaceId, nodeIds);
  if (targets.length === 0) return;
  await relinkBatch(workspaceId, targets, (await indexRowsNaming(workspaceId, targets)).map((row) => row.note_id), await staleNotesWithLinks(workspaceId),
    await edgesInto(workspaceId, targets.map((t) => t.id)));
}

type EdgeInto = { id: string; source_node_id: string; target_node_id: string };
/** The wikilink edges into `targetIds` (migration 241 node_edges_wikilink_target_idx answers it). */
async function edgesInto(workspaceId: string, targetIds: readonly string[]): Promise<EdgeInto[]> {
  if (targetIds.length === 0) return [];
  // one array, not a parameter a target: a folder move or a bundle can name more targets than a statement takes parameters (65,535)
  return db.selectFrom("node_edges").select(["id", "source_node_id", "target_node_id"]).where("workspace_id", "=", workspaceId).where("origin", "=", "wikilink")
    .where(sql<boolean>`target_node_id = ANY(${[...targetIds]}::uuid[])`).execute();
}

/** relinkTarget for one batch of targets. `indexed`: the notes whose up-to-date index row names one of them (a superset is fine: what each candidate really links to is
 *  matched exactly below: linkMatchesNodeSql, the space, the liveness, the name). `unread`: the live notes whose index row is stale and that hold a `[[`
 *  (staleNotesWithLinks; read once for all the batches of one call). `into`: the wikilink edges into the batch's targets now (edgesInto). */
async function relinkBatch(workspaceId: string, targets: readonly RelinkTarget[], indexed: readonly string[], unread: readonly string[], into: readonly EdgeInto[]): Promise<void> {
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
    `     -- Notes that link to a target now: they may have to lose the edge.
     SELECT unnest($1::uuid[])::text AS id
     UNION
     -- Indexed notes: the index says which names their text links to.
     SELECT unnest($8::uuid[])::text
     UNION
     -- A note whose index row is stale has not been read yet: look in its text.
     -- strpos, not LIKE '%[[%': the planner may answer a LIKE through the
     -- pgroonga text index, whose tokenizer reads "![[" as one token, so an
     -- embed-only note ("see ![[Name]]") was dropped whenever that plan won.
     -- Those notes are given (staleNotesWithLinks), not joined here: a join of the stale rows with the notes was planned as a read of every live note (issue #2021).
     SELECT s.id::text FROM ${notesWithIdsSql("$7::uuid[]")} s
      WHERE EXISTS (
        SELECT 1 FROM unnest($2::uuid[], $9::uuid[], $10::boolean[]) t(id, space_id, tag)
         WHERE t.id <> s.id AND (t.tag OR t.space_id IS NOT DISTINCT FROM s.space_id)
           AND (EXISTS (SELECT 1 FROM unnest($3::uuid[], $4::text[]) k(target_id, name)
                         -- CASE: the text is searched only for this target's names (Postgres put the search before the cheap check: every name of the batch searched)
                         WHERE CASE WHEN k.target_id = t.id THEN strpos(lower(s.markdown), lower(k.name)) > 0 ELSE false END)
                OR EXISTS (SELECT 1 FROM unnest($5::uuid[], $6::text[]) k(target_id, pattern)
                            WHERE CASE WHEN k.target_id = t.id THEN s.markdown ~* k.pattern ELSE false END)
                OR strpos(lower(s.markdown), '${NODE_REF_PREFIX}' || t.id::text) > 0))`,
    [[...new Set(into.map((e) => e.source_node_id))], targetIds, names.map(([id]) => id), names.map(([, name]) => name),
      patterns.map(([id]) => id), patterns.map(([, pattern]) => pattern), unread, indexed,
      targets.map((t) => t.space_id), targets.map((t) => t.tag)],
  );
  // by the primary key only (notesWithIdsSql says why)
  const candidates = { rows: found.rows.length === 0 ? [] : await db.selectFrom(notesWithIds(found.rows.map((r) => r.id)).as("c"))
    .select(["c.id", "c.markdown"]).where("c.workspace_id", "=", workspaceId).execute() };

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
       JOIN ${notesWithIdsSql("$2::uuid[]")} s ON s.id = l.source_id
       JOIN ${notesWithIdsSql("$5::uuid[]")} n ON n.workspace_id = $1
      WHERE ${linkMatchesNodeSql("n", "s", "ARRAY[l.link_lc]", "ARRAY[l.link_slug]")}`,
    [workspaceId, linkSource, linkLc, linkSlugs, targetIds],
  );

  // Drop what no longer names its target (by id: the edges into the batch were read with it); surviving rows keep their ids.
  const kept = new Set(named.rows.map((r) => `${r.source_id}/${r.target_id}`));
  const dropped = into.filter((e) => !kept.has(`${e.source_node_id}/${e.target_node_id}`)).map((e) => e.id);
  if (dropped.length) await q(`DELETE FROM node_edges WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, dropped]);
  // A trashed source keeps the edges it still has and gains none; its own
  // syncWikilinkEdges runs when it comes back.
  for (const row of named.rows) {
    if (row.live) await q(UPSERT_WIKILINK_EDGE, [workspaceId, row.source_id, row.target_id]);
  }
}
