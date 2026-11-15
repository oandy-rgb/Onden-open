// The site's old addresses (GAP-240; contract in
// docs/architecture/proposals/site-stable-urls-2026-11-04.md §2). A note's slug
// follows its title (services/nodes.ts slugFor, D55), so a rename changes its
// address on the next Publish. Each snapshot therefore carries the addresses
// earlier snapshots served, as `payload.redirects`: old slug → note (or tag) id,
// oldest first, carried from snapshot to snapshot — but only for notes and tags
// on the site it is built for. A snapshot never names a note taken down before
// it (publishRedaction.property): taken down, a note's old addresses go, and
// published again it starts from its current address. The served site
// (servedSite.applyTakedown) resolves them to the pages it serves now and drops
// the rest, so an address of a note taken down since the last Publish is a 404
// that names nothing — never a redirect to its new, title-bearing address.
import { sql } from "kysely";
import { db } from "../../../dbKysely.js";

/** How many old addresses of each kind a snapshot keeps; past it the oldest go. */
export const REDIRECTS_MAX = 1000;

/** Old slugs and the note or tag each belongs to, oldest first. A list, not
 *  an object keyed by slug: a slug such as `2024` is an integer-like key, and an
 *  object would reorder it. Each entry names its owner as `id`, so purging a
 *  note (purgedContent.withoutNodes) drops its old addresses with it. */
export type RedirectEntry = { slug: string; id: string };
export type StoredRedirects = { notes: RedirectEntry[]; tags: RedirectEntry[] };
/** One old address and the address it now goes to: `/site/<old>/` → `/site/<slug>/`. */
export type SiteRedirect = { from: string; to: string };

/** The redirects the next snapshot carries: the previous snapshot's, then the
 *  addresses that snapshot served (`previousLive`) as the newest — only of the
 *  notes or tags on the new site (`liveNow`), minus every slug a page there has
 *  (a page in use wins over an old address), at most `max`, oldest dropped
 *  first. Pure. */
export function nextRedirects(
  previous: readonly RedirectEntry[], previousLive: readonly RedirectEntry[], liveNow: readonly RedirectEntry[], max = REDIRECTS_MAX,
): RedirectEntry[] {
  const onSite = new Set(liveNow.map((page) => page.id));
  const out = new Map<string, string>();
  for (const { slug, id } of [...previous, ...previousLive]) {
    if (!onSite.has(id)) continue; // taken down: the new snapshot does not name it
    out.delete(slug); // re-inserted as the newest
    out.set(slug, id);
  }
  for (const { slug } of liveNow) out.delete(slug);
  const entries = [...out].map(([slug, id]) => ({ slug, id }));
  return entries.slice(Math.max(0, entries.length - max));
}

function entriesOf(value: unknown): RedirectEntry[] {
  return Array.isArray(value)
    ? value.filter((e): e is RedirectEntry => !!e && typeof e === "object"
      && typeof e.slug === "string" && e.slug !== "" && typeof e.id === "string" && e.id !== "")
    : [];
}

/** The redirects a snapshot of `notes` and `tagPages` stores, from the latest
 *  snapshot of the workspace; null when there are none (the first Publish, or
 *  nothing ever moved). Read inside the publish transaction. */
export async function snapshotRedirects(
  workspaceId: string,
  notes: ReadonlyArray<{ id: string; slug: string }>,
  tagPages: Readonly<Record<string, { slug: string }>>,
): Promise<StoredRedirects | null> {
  // The ids and slugs only: a snapshot's nodes hold every published note's text.
  const previous = (await sql<{ redirects: unknown; notes: unknown; tags: unknown }>`
    SELECT payload->'redirects' AS redirects,
           (SELECT coalesce(jsonb_agg(jsonb_build_object('id', n->>'id', 'slug', n->>'slug')), '[]'::jsonb)
              FROM jsonb_array_elements(coalesce(payload->'nodes', '[]'::jsonb)) n
             WHERE n->>'id' IS NOT NULL AND n->>'slug' IS NOT NULL) AS notes,
           (SELECT coalesce(jsonb_agg(jsonb_build_object('id', t.key, 'slug', t.value->>'slug')), '[]'::jsonb)
              FROM jsonb_each(CASE WHEN jsonb_typeof(payload->'presentation'->'design'->'tag_pages') = 'object'
                                   THEN payload->'presentation'->'design'->'tag_pages' ELSE '{}'::jsonb END) t
             WHERE t.value->>'slug' IS NOT NULL) AS tags
      FROM publish_snapshots WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC LIMIT 1`.execute(db)).rows[0];
  if (!previous) return null;
  const stored = (previous.redirects ?? {}) as { notes?: unknown; tags?: unknown };
  const result: StoredRedirects = {
    notes: nextRedirects(entriesOf(stored.notes), entriesOf(previous.notes), notes.map((n) => ({ id: n.id, slug: n.slug }))),
    tags: nextRedirects(entriesOf(stored.tags), entriesOf(previous.tags), Object.entries(tagPages).map(([id, p]) => ({ id, slug: p.slug }))),
  };
  return result.notes.length > 0 || result.tags.length > 0 ? result : null;
}

/** A snapshot's stored redirects as the served site answers them: only those
 *  whose note or tag page is served now (`notes`, `tagPages`, already cut down
 *  by the takedown), to that page's current address. An old address a served
 *  page uses now is left to the page. */
export function servedRedirects(
  stored: unknown,
  notes: ReadonlyArray<{ id?: unknown; slug?: unknown }>,
  tagPages: unknown,
): SiteRedirect[] {
  const value = (stored && typeof stored === "object" ? stored : {}) as { notes?: unknown; tags?: unknown };
  const out: SiteRedirect[] = [];
  const add = (entries: RedirectEntry[], current: Map<string, string>, prefix: string) => {
    const live = new Set(current.values());
    for (const { slug: old, id } of entries) {
      const slug = current.get(id);
      if (slug !== undefined && !live.has(old)) out.push({ from: `${prefix}${old}/`, to: `${prefix}${slug}/` });
    }
  };
  const noteSlugs = new Map<string, string>();
  for (const n of notes) if (typeof n.id === "string" && typeof n.slug === "string") noteSlugs.set(n.id, n.slug);
  add(entriesOf(value.notes), noteSlugs, "/site/");
  const tagSlugs = new Map<string, string>();
  if (tagPages && typeof tagPages === "object") {
    for (const [id, page] of Object.entries(tagPages as Record<string, { slug?: unknown }>)) {
      if (page && typeof page.slug === "string") tagSlugs.set(id, page.slug);
    }
  }
  add(entriesOf(value.tags), tagSlugs, "/site/tag/");
  return out;
}
