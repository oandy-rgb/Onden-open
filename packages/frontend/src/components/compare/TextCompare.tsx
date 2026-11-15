// The two-version compare, loaded when it first opens (contract: ./comparePlaces.ts).
import { Suspense } from "react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { useT } from "../../lib/i18n";
import EmptyState from "../EmptyState";
import type { TextCompareViewProps } from "./TextCompareView";

const TextCompareView = lazyWithReload(() => import("./TextCompareView"));

export type { TextCompareViewProps as TextCompareProps } from "./TextCompareView";

export default function TextCompare(props: TextCompareViewProps) {
  const t = useT();
  return (
    <Suspense fallback={<EmptyState size="inline" title={t("Loading…")} />}>
      <TextCompareView {...props} />
    </Suspense>
  );
}
