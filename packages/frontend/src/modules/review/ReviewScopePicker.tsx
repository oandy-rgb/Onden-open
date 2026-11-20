import { useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ReviewGroup, ReviewGroups } from "@onden/contract";
import { Button, Sheet, SheetHeader, SearchField } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import { containsTitle } from "../../lib/noteSearch";
import { getNode, useAllNodes, useTagRows } from "../../lib/appStore";
import { ancestorsOf, indexById } from "../../lib/treeWalk";
import { useLiveResource } from "./useLiveResource";
import { useReviewStats } from "./useReviewStats";
import { placeOfGroup, formatPlace, type ReviewScope } from "./reviewPlace";
import "./ReviewScopePicker.css";

// 「範圍」 under the review page's title: which cards this session, its remaining count and the status page cover.
// All cards, a note and everything under it, a tag, or the cards under no tag. The rows and their counts are the
// status page's groups (GET /api/review/groups, one read per kind) and a pick is placeOfGroup, so 「練這組」 and
// this list open the same scope. Which notes are offered: the top-most notes that hold cards somewhere under
// them (the server's by=note rows); each shows where it sits ("2.Area › 作業系統") and the list is searchable.

const ROW_LIMIT = 50;

type Props = { online: boolean; scope: ReviewScope; onChoose: (scope: ReviewScope) => void };

/** What the scope is called on screen: "All cards", a note's title, "#tag", "No tag". */
export function useScopeName(scope: ReviewScope): string {
  const t = useT();
  const tags = useTagRows();
  return scope.kind === "all" ? t("All")
    : scope.kind === "untagged" ? t("No tag")
    : scope.kind === "tag" ? `#${displayTitle(tags?.find((tag) => tag.id === scope.id)?.name)}`
    : displayTitle(getNode(scope.id)?.title);
}

export default function ReviewScopePicker({ online, scope, onChoose }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const name = useScopeName(scope);
  return (
    <div className="review-scope-bar">
      <Button type="button" variant="ghost" className="review-scope-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="review-scope-label">{t("Review scope")}</span>
        <strong className="review-scope-name">{name}</strong>
        <ChevronDown size={16} aria-hidden="true" />
      </Button>
      {open && <ScopeSheet online={online} scope={scope} onClose={() => setOpen(false)} onChoose={(next) => { setOpen(false); onChoose(next); }} />}
    </div>
  );
}

function ScopeSheet({ online, scope, onChoose, onClose }: Props & { onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const { stats } = useReviewStats();
  const tagAnswer = useLiveResource<ReviewGroups, ReviewGroups | null>("/api/review/groups?by=tag", (raw) => raw, null, 60_000).value;
  const noteAnswer = useLiveResource<ReviewGroups, ReviewGroups | null>("/api/review/groups?by=note", (raw) => raw, null, 60_000).value;
  const current = formatPlace(scope);
  const q = query.trim().toLowerCase();

  const nodes = useAllNodes();
  const noteRows = useMemo(() => {
    const byId = indexById(nodes);
    return (noteAnswer?.groups ?? []).map((group) => {
      const note = group.id ? byId.get(group.id) : undefined;
      const path = note ? ancestorsOf(byId, note).map((above) => displayTitle(above.title)).join(" › ") : "";
      return { group, path, title: displayTitle(note?.title ?? group.title) };
    });
  }, [noteAnswer, nodes]);
  const matching = <R extends { title: string; path?: string }>(rows: R[]) => rows.filter((row) => !q || containsTitle(q, `${row.path ?? ""} ${row.title}`));
  const noteList = matching(noteRows);
  const tagRows = (tagAnswer?.groups ?? []).filter((group) => group.id !== null).map((group) => ({ group, title: displayTitle(group.title) }));
  const tagList = matching(tagRows);
  const untagged = tagAnswer?.groups.find((group) => group.id === null) ?? null;
  const searchable = noteRows.length + tagRows.length > 8;
  const loading = noteAnswer === null || tagAnswer === null;

  const row = (key: string, place: ReviewScope, title: string, counts: string, hint?: string) => (
    <li key={key}>
      <Button type="button" variant="ghost" className="review-scope-row-button" aria-pressed={formatPlace(place) === current}
        disabled={!online && place.kind !== "all"} onClick={() => onChoose(place)}>
        <span className="review-scope-row-text">
          <span className="review-scope-row-title">{title}</span>
          {hint && <span className="review-scope-row-hint">{hint}</span>}
        </span>
        <span className="review-scope-row-counts">{counts}</span>
        {formatPlace(place) === current && <Check size={15} aria-hidden="true" />}
      </Button>
    </li>
  );
  const counts = (group: ReviewGroup) => group.due + group.new === 0 ? t("Nothing today")
    : `${t("{n} due", { n: group.due })} · ${t("{n} new", { n: group.new })}`;
  const limited = <R,>(rows: R[]) => rows.filter((_, index) => index < ROW_LIMIT);

  return (
    <Sheet label={t("Review scope")} className="review-scope-layer" cardClassName="review-scope-sheet" steady onClose={onClose}>
      <SheetHeader title={t("Review scope")} onClose={onClose} />
      {searchable && <SearchField label={t("Search notes and tags…")} value={query} onValueChange={setQuery} />}
      <div className="review-scope-list">
        {!q && <ul className="review-scope-options">
          {row("all", { kind: "all" }, t("All"), stats ? t("{n} to review", { n: stats.due }) : "")}
        </ul>}
        {loading ? <p className="review-scope-note">{online ? t("Loading…") : t("Choosing a scope needs a connection.")}</p> : (
          <>
            {noteList.length > 0 && (
              <section aria-label={t("Notes")}>
                <h3 className="review-scope-heading">{t("Notes")}</h3>
                <ul className="review-scope-options">
                  {limited(noteList).map(({ group, path, title }) => row(`root.${group.id}`, placeOfGroup("note", group.id) as ReviewScope, title, counts(group), path || undefined))}
                </ul>
              </section>
            )}
            {tagList.length > 0 && (
              <section aria-label={t("Tags")}>
                <h3 className="review-scope-heading">{t("Tags")}</h3>
                <ul className="review-scope-options">
                  {limited(tagList).map(({ group, title }) => row(`tag.${group.id}`, placeOfGroup("tag", group.id) as ReviewScope, `#${title}`, counts(group)))}
                </ul>
              </section>
            )}
            {untagged && !q && (
              <ul className="review-scope-options">{row("untagged", { kind: "untagged" }, t("No tag"), counts(untagged))}</ul>
            )}
            {q && noteList.length + tagList.length === 0 && <p className="review-scope-note">{t("Nothing matches")}</p>}
            {noteRows.length + tagRows.length === 0 && !untagged && <p className="review-scope-note">{t("No review cards yet. On a paragraph, choose “Make this block a review card” to add one.")}</p>}
          </>
        )}
      </div>
    </Sheet>
  );
}
