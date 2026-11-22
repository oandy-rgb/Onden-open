import { ExternalLink } from "lucide-react";
import { ReaderArticle } from "../../components/markdownSurfaces";
import { Link } from "../../components/ui";
import { useT } from "../../lib/i18n";

/** A page of the same source, opened from a link inside an article (backend modules/rss/links.ts): read here, kept
 *  nowhere. While it loads, or when it has no article to read, the way to the browser is a tap away. */
export type LinkedPage =
  | { url: string; status: "loading" }
  | { url: string; status: "failed" }
  | { url: string; status: "page"; title: string; body: string };

export default function RssLinkedPage({ page, sourceTitle, resolveImage }: {
  page: LinkedPage; sourceTitle: string;
  /** An image path in the page, made whole against its address. */
  resolveImage: (src: string, pageUrl: string) => string;
}) {
  const t = useT();
  const original = (
    <Link href={page.url} target="_blank" rel="noreferrer noopener" className="rss-article-link">
      <ExternalLink size={11} /> {t(page.status === "page" ? "original" : "Open in the browser")}
    </Link>
  );
  if (page.status !== "page") {
    return (
      <div className="rss-article-scroll rss-linked-page">
        <p className="rss-fulltext-fallback" role="status">
          {page.status === "loading" ? t("Loading the article…") : t("This page can't be read here.")} {original}
        </p>
      </div>
    );
  }
  return (
    <div className="rss-article-scroll rss-linked-page" key={page.url}>
      <div className="rss-article-head">
        <div className="rss-article-head-row"><h3 className="rss-article-title" data-user-content>{page.title}</h3></div>
        <div className="rss-article-meta"><span>{sourceTitle}</span>{original}</div>
      </div>
      <div className="rss-article-body" data-user-content={page.body ? true : undefined}>
        <ReaderArticle resolveImage={(src) => resolveImage(src, page.url)}>{page.body}</ReaderArticle>
      </div>
    </div>
  );
}
