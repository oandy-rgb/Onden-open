import { Suspense, useEffect } from "react";
import type { ModuleScreenProps } from "../types";
import { lazyWithReload } from "../../lib/lazyWithReload";
import EmptyState from "../../components/EmptyState";
import { useT } from "../../lib/i18n";
import { navigate } from "../../lib/historyIntent";
import { getModuleAddress, setModuleAddress, useModuleAddress } from "../../lib/moduleAddress";
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
  const saved = parseReviewScope(savedText) ?? ALL;
  // The 範圍 is the address's, or where the person left off when the page opens with none (reload keeps the address).
  const scope: ReviewScope = isScope(place) ? place : address === null ? saved : ALL;
  // No address: put the remembered scope into it (no history entry), so Back from a pick returns to a place that says what it is.
  useEffect(() => { if (address === null) setModuleAddress(formatPlace(saved)); }, [address]); // eslint-disable-line react-hooks/exhaustive-deps -- `saved` only matters when the address is empty
  // Opened from elsewhere: that target is where this page starts. No history intent: the open itself made the
  // entry, and an address change on the same page rewrites it.
  useEffect(() => {
    if (!target) return;
    setModuleAddress(formatPlace(target.rootId ? { kind: "root", id: target.rootId } : target.page === "status" ? { kind: "status" } : ALL));
  }, [target]);
  // What the page shows is what is remembered: the status page and the next visit open on the same scope.
  useEffect(() => { if (isScope(place) && formatPlace(place) !== (savedText ?? "all")) saveScope(formatPlace(place)); }, [address]); // eslint-disable-line react-hooks/exhaustive-deps -- runs when the shown place changes

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
    />
  );
}
