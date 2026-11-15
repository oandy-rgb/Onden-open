// One page of the site drawn in the app: the same header, boxes and foot the
// published site draws (components/siteFrame), inside the design's style frame.
// The publish dialog's 「看網站」, the website screen and its previews all use it,
// so what the owner sees is what the page does (design doc §5).
import { useMemo } from "react";
import { usesLegacyHome, type SchemeMode } from "@onden/site";
import { ArticleFrame, HomeBody, SiteFoot, SiteHeader, TagFrame, type SiteData } from "../../components/siteFrame";
import { SiteScope } from "./studio/SiteScope";
import { nodeOf } from "../../lib/nodeIndex";

export type SitePage = { kind: "home" } | { kind: "note"; noteId: string } | { kind: "tag"; tagId: string };

type Props = {
  data: SiteData;
  page: SitePage;
  mode?: SchemeMode;
  /** Draw the type at this width (a phone preview inside a wider window). */
  viewport?: number;
  className?: string;
  /** The website screen: boxes with nothing to show stay, with this word, and list boxes with room end in 「加一格」. */
  emptyLabel?: string;
  addLabel?: string;
  word?: (registryWord: string) => string;
};

export default function SiteRender({ data, page, mode, viewport, className, emptyLabel, addLabel, word }: Props) {
  const editing = useMemo(() => (emptyLabel === undefined ? undefined : { emptyLabel, addLabel, word }), [emptyLabel, addLabel, word]);
  const node = page.kind === "note" ? nodeOf(data, page.noteId) : undefined;
  const tag = page.kind === "tag" ? data.design.tag_pages[page.tagId] : undefined;
  const style = { style: data.design.style, css: data.design.css, home: usesLegacyHome(data.design) ? data.design.legacy_home : null };
  return (
    <SiteScope design={style} mode={mode} viewport={viewport} className={className}>
      <SiteHeader data={data} editing={editing} />
      <main className="s-frame-main">
        {page.kind === "home" ? <HomeBody data={data} editing={editing} /> : null}
        {node ? <ArticleFrame data={data} node={node} editing={editing} /> : null}
        {tag && page.kind === "tag" ? <TagFrame data={data} tagId={page.tagId} page={tag} editing={editing} /> : null}
      </main>
      <SiteFoot data={data} editing={editing} />
    </SiteScope>
  );
}
