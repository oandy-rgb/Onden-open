import { Suspense, useEffect, useMemo } from "react";
import type { ModuleScreenProps } from "../types";
import { lazyWithReload } from "../../lib/lazyWithReload";
import EmptyState from "../../components/EmptyState";
import { useT } from "../../lib/i18n";
import { navigate } from "../../lib/historyIntent";
import { getModuleAddress, setModuleAddress, useModuleAddress } from "../../lib/moduleAddress";
import { settledWithin } from "../../lib/syncedPrefStore";
import ReviewPanel from "./ReviewPanel";
import ReviewScopePicker from "./ReviewScopePicker";
import { reviewScopePref, parseReviewScope } from "./reviewScopePref";
import { formatPlace, isScope, parsePlace, type ReviewPlace, type ReviewScope } from "./reviewPlace";

// The FSRS study session as a full page (`?view=review`). Where inside it the person is (all cards, the status
// page, or the cards of one group) is the page's address (reviewPlace), so a reload and Back keep it; moving
// between places is a new history entry. A target from elsewhere (the home line, a note's command) is turned
// into that address once. The status page is its own chunk.
const ReviewStatusPage = lazyWithReload(() => import("./ReviewStatusPage"));

const ALL: ReviewScope = { kind: "all" };

/** Go to `place` (null: all cards) as a new page, so Back returns to where the person was. */
const goTo = (place: ReviewPlace | null) => {
  if (formatPlace(place) !== getModuleAddress()) navigate(() => setModuleAddress(formatPlace(place)), { history: "push" });
};

export default function ReviewScreen({ online, target, onOpenNode, onRefresh }: ModuleScreenProps) {
  const t = useT();
  const address = useModuleAddress();
  const place = parsePlace(address);
  const { value: savedText, save: saveScope } = reviewScopePref.useValue();
  const savedKey = formatPlace(parseReviewScope(savedText) ?? ALL)!;
  // The 範圍 is the address's, else all cards: with no address the page waits for the remembered scope (below). Memoised on its text,
  // so a re-render of the host hands the session an equal scope, not a new one.
  const scopeKey = isScope(place) ? formatPlace(place)! : "all";
  const scope = useMemo(() => parsePlace(scopeKey) as ReviewScope, [scopeKey]);
  const saved = useMemo(() => parsePlace(savedKey) as ReviewScope, [savedKey]);
  // No address: put the remembered scope into it (no history entry), so Back from a pick returns to a place that says what it is.
  // A new device has not heard the account's choice yet: wait for it (a moment at most, offline too) before deciding.
  useEffect(() => {
    if (address !== null) return;
    let alive = true;
    void settledWithin(reviewScopePref.store, 1500).then(() => {
      if (alive) setModuleAddress(formatPlace(parseReviewScope(reviewScopePref.store.get().value) ?? ALL));
    });
    return () => { alive = false; };
  }, [address]);
  // Opened from elsewhere: that target is where this page starts. No history intent: the open itself made the
  // entry, and an address change on the same page rewrites it.
  useEffect(() => {
    if (!target) return;
    setModuleAddress(formatPlace(target.rootId ? { kind: "root", id: target.rootId } : target.page === "status" ? { kind: "status" } : ALL));
  }, [target]);
  // What the page shows is what is remembered: the status page and the next visit open on the same scope.
  useEffect(() => { if (isScope(place) && formatPlace(place) !== (savedText ?? "all")) saveScope(formatPlace(place)); }, [address]); // eslint-disable-line react-hooks/exhaustive-deps -- runs when the shown place changes

  if (address === null) return <EmptyState size="inline" title={t("Loading…")} />;
  if (place?.kind === "status") {
    return (
      <Suspense fallback={<EmptyState size="inline" title={t("Loading…")} />}>
        <ReviewStatusPage online={online} scope={saved} onBack={() => goTo(saved)} onOpenNode={onOpenNode} onChanged={onRefresh} onPractise={goTo} />
      </Suspense>
    );
  }
  return (
    <ReviewPanel
      online={online}
      onOpenNode={onOpenNode}
      onGraded={onRefresh}
      onOpenStatus={() => goTo({ kind: "status" })}
      scope={scope}
      scopePicker={<ReviewScopePicker online={online} scope={scope} onChoose={goTo} />}
      onShowAll={() => goTo(ALL)}
      // The remembered tag is gone: all cards, in place (no history entry); the page then remembers "all".
      onScopeGone={() => setModuleAddress("all")}
    />
  );
}
