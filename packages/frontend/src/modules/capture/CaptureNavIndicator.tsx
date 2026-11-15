import { useTagRows, useAllNodes } from "../../lib/appStore";
import { useT } from "../../lib/i18n";
import type { NavIndicatorProps } from "../types";
import { useDecisionTotal } from "../../hooks/DecisionsContext";
import { pendingCaptures } from "./inbox";

/** The mark on the inbox's navigation entry (更多): the captures that wait to be
 *  filed plus the things that wait for a decision; a plain dot where a
 *  container folds the entry (`dotOnly`). Nothing when the inbox is empty. */
export default function CaptureNavIndicator({ dotOnly = false }: NavIndicatorProps) {
  const t = useT();
  const nodes = useAllNodes();
  const tags = useTagRows();
  const waiting = pendingCaptures(nodes, tags).length + useDecisionTotal();
  if (waiting === 0) return null;
  if (dotOnly) return <span className="nav-indicator nav-indicator--dot" role="img" aria-label={t("Waiting in the inbox")} />;
  return (
    <span className="nav-indicator nav-indicator--count" aria-label={t("{n} waiting in the inbox", { n: waiting })}>{waiting}</span>
  );
}
