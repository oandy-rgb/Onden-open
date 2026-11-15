// What the website screen draws: the site the SERVER would publish now (its publish preview, the
// candidate buildCandidate/freezeDesign make), read into the snapshot shape the pages use. The screen
// never builds the reader's view itself — links to private notes, hidden tags, child-tag members and
// each tag's saved view are the server's one projection, so the preview cannot show a reader more or
// less than the published site does (publish-redesign §5.3).
import { compareText } from "@onden/markdown";
import type { SiteDesign } from "@onden/site";
import { readSiteData, type SiteData } from "../../../components/siteFrame";
import type { PublishedNode } from "../../../components/templates";
import type { PublishPreview } from "@onden/contract";

/** The candidate of `preview` as page data. */
export function siteDataOfPreview(preview: PublishPreview): SiteData {
  const { site } = preview;
  return readSiteData({ title: site.title, home_node_id: site.home_node_id, payload: site.payload as Parameters<typeof readSiteData>[0]["payload"] });
}

/** `site` drawn with `design`: its boxes, style and CSS; the notes, tag pages and links stay the candidate's. */
export function withDesign(site: SiteData, design: SiteDesign): SiteData {
  return { ...site, design: { ...design, resolved: site.design.resolved, tag_pages: site.design.tag_pages, tag_names: site.design.tag_names } };
}

/** The article the page preview shows by default: the published note that fills the most boxes
 *  (headings, footnotes, links in) so a first look shows what the widgets do; else the newest. */
export function sampleNoteId(data: SiteData): string | null {
  const score = (n: PublishedNode) =>
    (n.markdown.match(/^#{2,3}\s/gm)?.length ?? 0) + (n.markdown.match(/\[\^[^\]]+\]/g)?.length ?? 0) + data.edges.filter((e) => e.target_node_id === n.id).length * 3;
  const articles = data.nodes.filter((n) => n.id !== data.homeNodeId && !(n.id in data.design.tag_pages));
  return [...articles].sort((a, b) => score(b) - score(a) || compareText(b.updated_at ?? "", a.updated_at ?? "") || compareText(a.id, b.id))[0]?.id ?? null;
}

/** The tag page the preview shows by default: the one with the most notes. */
export function sampleTagId(data: SiteData): string | null {
  return Object.entries(data.design.tag_pages).sort(([ai, a], [bi, b]) => b.rows.length - a.rows.length || compareText(ai, bi))[0]?.[0] ?? null;
}
