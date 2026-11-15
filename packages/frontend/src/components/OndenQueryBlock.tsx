// The live query block of the app: parses the block (@onden/markdown
// parseQuerySpec, shared with the server) and POSTs it to /api/query. Only
// the app profile mounts it; the published site and the exports draw the
// result frozen at publish time instead (D113, MarkdownRenderer).

import { useEffect, useState } from "react";
import { parseQuerySpec } from "@onden/markdown";

import "./OndenQueryBlock.css";
import { useT } from "../lib/i18n";
import { dateLabel } from "../lib/timeLabels";
import { reads, writeErrors } from "../lib/data";
import { ApiError, readErrorBody } from "../lib/api";
import EmptyState from "./EmptyState";
import { Pressable } from "./ui";

/** A note, or a block node a tag query lists (docs/architecture/block-nodes.md §9):
 *  then `id`, `title` and `slug` are its note's. */
type QueryRow = { id: string; title: string; slug: string; updated_at: string; block?: { id: string; ref: string; label: string } };
/** A Page (backend services/paging.ts): `total` counts every match, notes and
 *  blocks alike, `rows` is this page of them. */
type QueryResult = { rows: QueryRow[]; total: number; next: number | null };

type Props = {
  /** Raw text inside the ``` block, with the trailing newline already
   *  trimmed by the markdown renderer. */
  source: string;
  /** Click-through handler — used to navigate within the editor. */
  onSelectNode?: (slug: string) => void;
};

export default function OndenQueryBlock({ source, onSelectNode }: Props) {
  const t = useT();
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const parsed = parseQuerySpec(source);
    if (!parsed.ok) {
      setResult(null);
      setLoading(false);
      setError(
        parsed.problem === "unknown_key"
          ? t("Unknown query key “{key}”. Use tags, where, sort, limit or offset.", { key: parsed.detail })
          : parsed.problem === "bad_number"
            ? t("“{key}” needs a whole number.", { key: parsed.detail })
            : t("Can't read this query line: {line}", { line: parsed.detail }),
      );
      return;
    }
    const spec = parsed.spec;
    setLoading(true);
    setError(null);
    // Single try/catch around the WHOLE pipeline (fetch + body read/parse):
    // a truncated body makes res.json() throw too, and every failure must
    // exit the loading state into the error state — never a stuck spinner
    // or a stale result next to an error.
    (async () => {
      try {
        const res = await reads.workspace.query(spec);
        if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
        const body = await res.json() as QueryResult;
        if (!cancelled) setResult(body);
      } catch (e) {
        if (!cancelled) {
          setError(writeErrors.requestMessage(e, t("query failed")));
          setResult(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [source, t]);

  return (
    <div className="onden-query-block">
      <div className="onden-query-head">
        <span className="onden-query-label">{t("query")}</span>
        {loading && <span className="onden-query-meta">{t("loading…")}</span>}
        {!loading && result && (
          <span className="onden-query-meta">{(() => {
            // The whole match, not this page's length (D66): 120 notes with
            // the default page of 50 say "120 matches · showing 50".
            const count = result.total;
            const label = t(count === 1 ? "{count} match" : "{count} matches", { count });
            return result.rows.length < result.total
              ? `${label} · ${t("showing {shown}", { shown: result.rows.length })}`
              : label;
          })()}</span>
        )}
      </div>
      {error && <p className="onden-query-error">{error}</p>}
      {result && result.rows.length > 0 && (
        <ul className="onden-query-results">
          {result.rows.map((r) => (
            <li key={r.block ? `${r.id}:${r.block.id}` : r.id} className={r.block ? "onden-query-block-row" : undefined}>
              <Pressable
                className="onden-query-result-link"
                onClick={() => onSelectNode?.(r.slug)}
                title={r.slug}
              >
                {r.block ? r.block.label : r.title}
              </Pressable>
              <span className="onden-query-result-date">
                {r.block ? r.title : dateLabel(r.updated_at, "numeric")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {result && result.rows.length === 0 && !error && (
        <EmptyState size="inline" title={t("no matches")} />
      )}
    </div>
  );
}
