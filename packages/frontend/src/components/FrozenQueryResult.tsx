// An onden-query / onden-base block as readers of the published site see it
// (D113, the user's decision): the result frozen when the note was published
// (@onden/markdown queryBlocks.ts), listing published notes only. A static
// list, or a table when the block shows columns — the same rule the HTML
// exports draw (backend htmlUtils.ts frozenQueryHast). Never a live query: no
// request leaves the page.

import type { FrozenQueryBlock } from "@onden/markdown";
import { useT } from "../lib/i18n";
import EmptyState from "./EmptyState";
import { Link, Pressable } from "./ui";

type LinkNode = { id: string; slug: string };

type Props = {
  /** null: the page carries no result for this block (published before
   *  D113, or a body that isn't a published note's). */
  block: FrozenQueryBlock | null;
  /** The site's pages: a row links to its page while the site has it. */
  nodes?: readonly LinkNode[];
  onNavigate?: (slug: string, nodeId: string | null) => void;
  /** A row's address, when the page is not a single-page app: a real link
   *  (middle-click, copy link, crawlers) instead of a button. */
  linkHref?: (page: LinkNode) => string | null;
};

export default function FrozenQueryResult({ block, nodes, onNavigate, linkHref }: Props) {
  const t = useT();
  const wrap = (children: React.ReactNode) => <div className="onden-query-frozen">{children}</div>;
  if (!block) return wrap(<p className="onden-query-frozen-note">{t("This query's results are not included.")}</p>);
  if (block.problem) return wrap(<p className="onden-query-frozen-problem">{block.problem}</p>);
  if (block.rows.length === 0) return wrap(<EmptyState size="inline" title={t("No matches")} />);
  const title = (row: FrozenQueryBlock["rows"][number]) => {
    const page = nodes?.find((n) => n.id === row.id);
    if (!page) return <span>{row.title}</span>;
    const href = linkHref?.(page);
    if (href) return <Link className="published-inline-link" href={href}>{row.title}</Link>;
    return (
      <Pressable type="button" className="published-inline-link"
        onClick={() => onNavigate?.(page.slug, page.id)}>
        {row.title}
      </Pressable>
    );
  };
  return wrap(<>
    {block.columns.length === 0 ? (
      <ul className="onden-query-frozen-list">
        {block.rows.map((row, i) => (
          <li key={`${row.id}:${i}`}>
            {title(row)}
            {row.note && <span className="onden-query-frozen-in">{row.note}</span>}
          </li>
        ))}
      </ul>
    ) : (
      <table className="onden-query-frozen-table">
        <thead>
          <tr><th>{t("Title")}</th>{block.columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((row, i) => (
            <tr key={`${row.id}:${i}`}>
              <td>{title(row)}</td>
              {block.columns.map((c, j) => <td key={c}>{row.values?.[j] ?? ""}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    )}
    {block.more > 0 && <p className="onden-query-frozen-more">{t("+{count} more", { count: block.more })}</p>}
  </>);
}
