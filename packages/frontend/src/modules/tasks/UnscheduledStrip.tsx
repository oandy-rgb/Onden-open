// What waits above 今天's timeline, in two parts that are both dragged onto an hour to plan them:
//   「可以排進今天的 · N」 a card of what could go on today: late tasks and ones due today or
//     tomorrow (lib/tasks/todayCandidates). The first few rows; 「看全部」 opens the rest in the
//     same card. Its rows carry their own buttons (排到今天, 某天), nothing is hidden in a menu.
//     No candidates: no card.
//   「還沒排時間」 the other tasks of today with no slot yet, one line each, in a dashed frame so
//     they are not mistaken for blocks of the timeline.
//   Today empty (no tasks, no candidates): one sentence, and under it the first few 「隨時」 tasks
//     (same rows, same 排到今天 button, also draggable) with 「看全部」 to that tab; with 「隨時」
//     empty too, a button to add one. Neither shows while today has something.

import { useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import EmptyState from "../../components/EmptyState";
import { Pressable } from "../../components/ui";
import { CANDIDATES_SHOWN } from "../../lib/tasks";

type Props = {
  /** The rows of the tasks that can go on today (already in their order). */
  candidates: ReactNode[];
  /** The other rows: today's, no time yet. */
  rest: ReactNode[];
  /** Set only when today has nothing at all: the sentence, the first 「隨時」 rows and the way to 「隨時」 or to adding one. */
  empty?: { text: string; anytime: ReactNode[]; anytimeCount: number; onSeeAnytime: () => void; onAdd: () => void };
};

export default function UnscheduledStrip({ candidates, rest, empty }: Props) {
  const t = useT();
  const [all, setAll] = useState(false);
  if (candidates.length === 0 && rest.length === 0 && !empty) return null;
  const title = t("Can go on today · {n}", { n: candidates.length });
  const hidden = candidates.length - CANDIDATES_SHOWN;
  return (
    <>
      {empty && (empty.anytimeCount > 0 ? (
        <>
          <EmptyState size="inline" title={empty.text} />
          <section className="tk-candidates" aria-label={t("Can do anytime · {n}", { n: empty.anytimeCount })}>
            <header className="tk-candidates-head">
              <h3 className="tk-candidates-title">{t("Can do anytime · {n}", { n: empty.anytimeCount })}</h3>
              <Pressable type="button" className="tk-candidates-all" onClick={empty.onSeeAnytime}>{t("See all ›")}</Pressable>
            </header>
            <ul className="tasks-list">{empty.anytime}</ul>
          </section>
        </>
      ) : (
        <EmptyState size="panel" title={empty.text} ctaLabel={t("Add one thing")} onCta={empty.onAdd} />
      ))}
      {candidates.length > 0 && (
        <section className="tk-candidates" aria-label={title}>
          <header className="tk-candidates-head">
            <h3 className="tk-candidates-title">{title}</h3>
            {hidden > 0 && (
              <Pressable type="button" className="tk-candidates-all" aria-expanded={all} onClick={() => setAll((v) => !v)}>
                {all ? t("Show fewer") : t("See all ›")}
              </Pressable>
            )}
          </header>
          <ul className="tasks-list">{candidates.filter((_, index) => all || index < CANDIDATES_SHOWN)}</ul>
        </section>
      )}
      {rest.length > 0 && (
        <section className="tk-unscheduled" aria-label={t("Not scheduled yet")}>
          <h3 className="tk-unscheduled-head">{t("Not scheduled yet")}<span className="tasks-mode-count">{rest.length}</span></h3>
          <ul className="tasks-list">{rest}</ul>
        </section>
      )}
    </>
  );
}
