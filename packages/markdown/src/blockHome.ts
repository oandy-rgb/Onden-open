// The choice `[[A#^id]]` falls back to when A has no block `^id`, and the published site's use of
// it. noteHasBlock (the test of A's own text) is in blockRef.ts; the order of preference is
// described there.

import { noteHasBlock } from "./blockRef.js";
import { servedLinkTarget, type ServedPage } from "./sitePath.js";
import { parseEmbed } from "./embeds.js";

/** A note other than A that holds the `^id`, and how it relates to A. */
export type BlockHomeCandidate = {
  /** A descendant of A (its parent chain reaches A): where a paragraph moved
   *  into a child note lives. */
  underNamed: boolean;
  /** In A's space. Unknown (undefined) counts as not the same. */
  sameSpace: boolean;
};

/** The one candidate `[[A#^id]]` falls back to, or null (none, or still
 *  several after the preferences). Pure; the caller has already limited
 *  `candidates` to notes the reader may read. */
export function chooseBlockHome<C extends BlockHomeCandidate>(candidates: readonly C[]): C | null {
  let pool = candidates;
  for (const prefers of [(c: C) => c.underNamed, (c: C) => c.sameSpace]) {
    if (pool.length <= 1) break;
    const preferred = pool.filter(prefers);
    if (preferred.length > 0) pool = preferred;
  }
  return pool.length === 1 ? pool[0]! : null;
}

// ── The published site ─────────────────────────────────────────────────────
// The site's pages are the published set, already free of private notes, so
// holding the id in a served page's text is all it takes.

/** A served page with what the fallback needs to rank it. */
export type BlockServedPage = ServedPage & { parent_id?: string | null; space_id?: string | null; /** ids of the page's valid block anchors */ block_ids?: readonly string[] };

const holders = new WeakMap<readonly BlockServedPage[], Map<string, BlockServedPage[]>>();

/** The served pages whose anchors include each id; built once per served list
 *  (like servedLinkTarget's index). */
function holdersOf(served: readonly BlockServedPage[]): Map<string, BlockServedPage[]> {
  let index = holders.get(served);
  if (index) return index;
  index = new Map();
  for (const page of served) {
    for (const id of new Set(page.block_ids ?? [])) {
      const list = index.get(id);
      if (list) list.push(page); else index.set(id, [page]);
    }
  }
  holders.set(served, index);
  return index;
}

/** The served page a link to block `^id` of `named` opens: `named` when it
 *  holds the block (or its text is not carried, so there is nothing to look
 *  in), else the one other page that does (chooseBlockHome), else `named`
 *  again — a link never gets worse than it was. */
export function servedBlockPage<P extends BlockServedPage>(named: P, id: string, served: readonly P[]): P {
  if (typeof named.markdown !== "string" || !named.block_ids || noteHasBlock(named.block_ids, id)) return named;
  const others = (holdersOf(served).get(id) ?? []).filter((p) => p.id !== named.id);
  if (others.length === 0) return named;
  const parents = new Map(served.map((p) => [p.id, p.parent_id ?? null]));
  const underNamed = (page: BlockServedPage): boolean => {
    for (let at = parents.get(page.id) ?? null, hops = 0; at && hops < 64; at = parents.get(at) ?? null, hops++) {
      if (at === named.id) return true;
    }
    return false;
  };
  const home = chooseBlockHome(others.map((page) => ({
    page, underNamed: underNamed(page),
    sameSpace: named.space_id !== undefined && page.space_id === named.space_id,
  })));
  return (home?.page as P | undefined) ?? named;
}

/** The served page `[[body]]` (or `![[body]]`) opens when `body` carries a
 *  `#^id`: servedLinkTarget's page, moved to the block's home when that page
 *  lacks the block (servedBlockPage). `named` is the page the title names.
 *  Null when the body names no served page. */
export function servedBlockTarget<P extends BlockServedPage>(
  body: string, served: readonly P[], fromId?: string | null,
): { page: P; named: P } | null {
  const named = servedLinkTarget(body, served, fromId);
  if (!named) return null;
  const id = parseEmbed(body).blockId;
  return { page: id ? servedBlockPage(named, id, served) : named, named };
}
