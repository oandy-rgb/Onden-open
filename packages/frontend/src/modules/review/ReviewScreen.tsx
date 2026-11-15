import { Suspense, useEffect } from "react";
import type { ModuleScreenProps } from "../types";
import { lazyWithReload } from "../../lib/lazyWithReload";
import EmptyState from "../../components/EmptyState";
import { useT } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import { getNode, useTagRows } from "../../lib/appStore";
import { navigate } from "../../lib/historyIntent";
import { getModuleAddress, setModuleAddress, useModuleAddress } from "../../lib/moduleAddress";
import ReviewPanel from "./ReviewPanel";
import { formatPlace, parsePlace, type ReviewPlace } from "./reviewPlace";

// The FSRS study session as a full page (`?view=review`). Where inside it the person is (all cards, the status
// page, or the cards of one group) is the page's address (reviewPlace), so a reload and Back keep it; moving
// between places is a new history entry. A target from elsewhere (the home line, a note's command) is turned
// into that address once. The status page is its own chunk.
const ReviewStatusPage = lazyWithReload(() => import("./ReviewStatusPage"));

/** Go to `place` (null: all cards) as a new page, so Back returns to where the person was. */
const goTo = (place: ReviewPlace | null) => {
  if (formatPlace(place) !== getModuleAddress()) navigate(() => setModuleAddress(formatPlace(place)), { history: "push" });
};

export default function ReviewScreen({ online, target, onOpenNode, onRefresh }: ModuleScreenProps) {
  const t = useT();
  const place = parsePlace(useModuleAddress());
  const tags = useTagRows();
  // Opened from elsewhere: that target is where this page starts. No history intent: the open itself made the
  // entry, and an address change on the same page rewrites it.
  useEffect(() => {
    if (!target) return;
    setModuleAddress(formatPlace(target.rootId ? { kind: "root", id: target.rootId } : target.page === "status" ? { kind: "status" } : null));
  }, [target]);

  if (place?.kind === "status") {
    return (
      <Suspense fallback={<EmptyState size="inline" title={t("Loading…")} />}>
        <ReviewStatusPage online={online} onBack={() => goTo(null)} onOpenNode={onOpenNode} onChanged={onRefresh} onPractise={goTo} />
      </Suspense>
    );
  }
  const group = place ? {
    rootId: place.kind === "root" ? place.id : undefined,
    rootTitle: place.kind === "root" ? displayTitle(getNode(place.id)?.title) : undefined,
    tagId: place.kind === "tag" ? place.id : undefined,
    tagName: place.kind === "tag" ? displayTitle(tags?.find((tag) => tag.id === place.id)?.name) : undefined,
    untagged: place.kind === "untagged",
    onShowAll: () => goTo(null),
  } : {};
  return (
    <ReviewPanel
      online={online}
      onOpenNode={onOpenNode}
      onGraded={onRefresh}
      onOpenStatus={() => goTo({ kind: "status" })}
      {...group}
    />
  );
}
