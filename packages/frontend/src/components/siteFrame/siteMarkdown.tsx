// Note text on the published pages: the published-profile MarkdownRenderer with
// its [[links]] drawn as real anchors (middle-click, copy link and crawlers
// work), not the buttons the single-page site used.
import type { ReactNode } from "react";
import { headingFragment, servedBlockPage, sitePathFor, type DiagramLayout } from "@onden/markdown";
import MarkdownRenderer from "../MarkdownRenderer";
import MarkdownDiagram from "../MarkdownDiagram";
import StepsFigure, { type StepsLabels } from "../StepsFigure";
import { withBlockIds } from "../../lib/publishedNode";
import { makeT, resolveMediaSrc, type PublishedNode } from "../templates";

const noop = () => {};

/** `static`: for output with no script behind it (a feed body) — no interactive controls.
 *  `locale`: the site's language, for the footnote section's and a handwriting page's words.
 *  `diagrams`: the layouts made at publish time, by block text; a ```mermaid fence with one is drawn from them.
 *  `(markdown, fromId?) → ReactNode`. `fromId` is the page the text is from, whose
 *  frozen query results it shows (D113); without it any page's block matches. */
export function makeSiteMarkdown(nodes: PublishedNode[], { static: isStatic = false, locale, diagrams }: { static?: boolean; locale?: string; diagrams?: ReadonlyMap<string, DiagramLayout> } = {}): (markdown: string, fromId?: string | null) => ReactNode {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const t = makeT(locale);
  const footnoteLabels = { heading: t("footnotes"), back: (n: number) => t("footnoteBack").replace("{n}", String(n)) };
  // The server draws a step-by-step figure as its list of steps; the page's
  // own small script (SiteSteps.astro) makes it a player.
  const stepsLabels: StepsLabels = { prev: t("stepPrev"), next: t("stepNext"), expand: t("stepsAll"), collapse: t("stepsOne"), count: t("stepCount") };
  const handwritingAlt = (page: number) => t("handwritingPage").replace("{n}", String(page));
  const everyBlock = nodes.flatMap((n) => n.query_blocks ?? []);
  // A [[Note#Heading]] opens the note at that heading; a block reference opens
  // the note, or the published note that holds the block when the named one
  // no longer does (servedBlockPage).
  const linkHref = (target: { id: string }, blockId?: string, heading?: string): string | null => {
    const named = byId.get(target.id);
    const node = named && blockId ? servedBlockPage(withBlockIds(named), blockId, nodes.map(withBlockIds)) : named;
    const path = node && sitePathFor(node.id, nodes);
    if (!node || !path) return null;
    const fragment = heading ? headingFragment(node.markdown, heading) : null;
    return fragment ? `${path}${fragment}` : path;
  };
  const diagramFor = (source: string): ReactNode | null => {
    const layout = diagrams?.get(source);
    return layout ? <MarkdownDiagram layout={layout} /> : null;
  };
  // eslint-disable-next-line react/display-name -- a render callback, not a component
  return (markdown, fromId) => (
    <MarkdownRenderer
      nodes={nodes}
      queryBlocks={fromId ? byId.get(fromId)?.query_blocks ?? [] : everyBlock}
      blockAnchors={fromId ? byId.get(fromId)?.part_anchors ?? [] : undefined}
      onNavigate={noop}
      linkHref={linkHref}
      // The pages run no script but the search: a diagram would be an empty box,
      // so a mermaid fence stays readable code unless a layout from publish time draws it.
      diagrams={false}
      diagramFor={diagramFor}
      stepsView={StepsFigure}
      stepsLabels={stepsLabels}
      resolveImage={resolveMediaSrc}
      profile="published"
      footnoteLabels={footnoteLabels}
      handwritingAlt={handwritingAlt}
      linkStyle="published"
      static={isStatic}
    >
      {markdown}
    </MarkdownRenderer>
  );
}
