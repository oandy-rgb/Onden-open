import { isSystemAttr, KEPT_OFF_BY_PARENT_ATTR_KEY, PUBLISHED_ATTR_KEY } from "@onden/markdown";
import { nodeNeedsBody, type ContentNode } from "../../lib/api";
import { spaceLabel, type Space } from "../../lib/spaces";

// Only a PREDICTION, for when the server's answer isn't there (offline, before
// the first preview): whether the site would show a note. The rule itself is
// the server's — backend modules/website/publishing/publishedSet.ts
// `publishedNodeIds`, which the snapshot and the served site both use and which
// wins on any difference. In short (owner 2026-11-10): a note in a space that
// publishes is on the site unless its own 「不發布」 keeps it off, it is blank, or
// it is an article saved from a feed; 「發布」 brings a blank note or a saved
// article on anyway. The server also drops notes a read-restricted tag makes
// private, which the client doesn't evaluate, so that case is not predicted.

/** A note's own say on the site, 'true' (「發布」) or 'false' (「不發布」)
 *  (backend `PUBLISHED_KEY`, systemAttributes.ts). The one place the client spells it. */
export const PUBLISHED_ATTR = PUBLISHED_ATTR_KEY;
/** How the flag is written (a plain flag, not inherited by the notes under it). */
export const PUBLISHED_FLAG = { value_type: "bool" as const, is_inheritable: false };

export type PublishBlocker =
  | { reason: "hidden" }
  | { reason: "space"; space: string };

/** The first reason the site won't show `node`, or null when nothing here
 *  stops it. `spaces` is the viewer's space list; a space that isn't in it
 *  (not loaded yet, or offline) is not reported as blocking. */
export function publishBlocker(node: Pick<ContentNode, "hidden" | "space_id">, spaces: readonly Space[]): PublishBlocker | null {
  if (node.hidden) return { reason: "hidden" };
  const space = spaces.find((sp) => sp.id === node.space_id);
  if (space && space.capabilities.publish !== true) return { reason: "space", space: spaceLabel(space) };
  return null;
}

type StandingNode = Pick<ContentNode, "id" | "hidden" | "space_id" | "source_type" | "markdown" | "body_len" | "attrs">;

/** Whether the site would show `node`, and if not, why. `hasChild`: a note sits
 *  under it (appStore.hasChildNote), so it is not blank. */
export type SiteStanding =
  | { on: true }
  | { on: false; reason: PublishBlocker["reason"] | "kept_off" | "kept_off_by_parent" | "blank" | "saved_article" };

// The server's `markdown !~ '\\S'` (a row whose body is not loaded yet is not blank: nodeNeedsBody)
// (Postgres whitespace): not JS `trim()`, which also strips
// NBSP (U+00A0, U+2007, U+202F) and the BOM that Postgres counts as text.
const NO_WORDS = /^[\t-\r \u0085\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*$/;

export function siteStanding(node: StandingNode, spaces: readonly Space[], hasChild: boolean): SiteStanding {
  const flag = node.attrs?.[PUBLISHED_ATTR];
  const reason = publishBlocker(node, spaces)?.reason
    ?? (flag === "false" ? (node.attrs?.[KEPT_OFF_BY_PARENT_ATTR_KEY] === "true" ? "kept_off_by_parent" : "kept_off") : flag === "true" ? null
      : node.source_type === "rss" ? "saved_article"
      : !nodeNeedsBody(node) && NO_WORDS.test(node.markdown ?? "") && !hasChild && Object.keys(node.attrs ?? {}).every(isSystemAttr) ? "blank"
      : null);
  return reason ? { on: false, reason } : { on: true };
}
