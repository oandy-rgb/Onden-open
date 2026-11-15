import { Suspense } from "react";
import { barSummary, labelFor, type Decision, type OffPlace, type SuggestionLayout } from "../lib/aiSuggestions";
import { t } from "../lib/i18n";
import { Button } from "./ui";
import { lazyWithReload } from "../lib/lazyWithReload";

// The "Compare" button and view (with the CodeMirror merge package) load after the note, not with it.
const AiSuggestionCompare = lazyWithReload(() => import("./AiSuggestionCompare"));
import "./AiSuggestionBar.css";

/** The line above a note that has AI suggestions: how many, accept or reject
 *  them all, step through the places in the text, and the suggestions the text
 *  cannot show in place (the title, a comment on no paragraph, a paragraph
 *  that has since been edited). The places themselves are drawn in the editor
 *  (lib/editorSuggestions.ts); this bar only decides. A reader of the note
 *  sees the same list without buttons. Deciding needs a connection. */
export function AiSuggestionBar({ layout, markdown, canDecide, online, busy, onDecideAll, onDecideRow, decide, onStep }: {
  layout: SuggestionLayout;
  /** The note as it is now (the "Compare" view reads it beside the suggested text). */
  markdown: string;
  /** The person may change this note (not only read it). */
  canDecide: boolean;
  online: boolean;
  busy: boolean;
  onDecideAll(decision: Decision): void;
  onDecideRow(row: OffPlace, decision: Decision): void;
  decide(suggestionId: string, itemIds: string[], decision: Decision): Promise<boolean>;
  onStep(direction: 1 | -1): void;
}) {
  if (layout.total === 0) return null;
  const canAct = canDecide && online && !busy;
  const why = !online ? labelFor.offline() : undefined;
  return (
    <section className="ai-bar" aria-label={t("AI suggestions")}>
      {layout.skills.map((skill) => (
        <div key={`${skill.picked}:${skill.name}`} className="ai-bar-skill">
          <span>{skill.picked ? labelFor.skillPicked(skill.name) : labelFor.skillUsed(skill.name)}</span>
          {skill.reason && <span className="ai-bar-skill-reason">{skill.reason}</span>}
        </div>
      ))}
      <div className="ai-bar-summary">
        <span className="ai-bar-count">{barSummary(layout)}</span>
        {canDecide && (
          <span className="ai-bar-actions">
            {layout.places.length > 1 && (
              <>
                <Button size="sm" variant="ghost" onClick={() => onStep(-1)}>{t("Previous place")}</Button>
                <Button size="sm" variant="ghost" onClick={() => onStep(1)}>{t("Next place")}</Button>
              </>
            )}
            <Button size="sm" variant="primary" disabled={!canAct || layout.actionable === 0} title={why} aria-busy={busy || undefined}
              onClick={() => onDecideAll("accept")}>{t("Accept all")}</Button>
            <Button size="sm" variant="secondary" disabled={!canAct} title={why} onClick={() => onDecideAll("reject")}>{t("Reject all")}</Button>
          </span>
        )}
      </div>
      {layout.places.length > 0 && (
        <Suspense fallback={null}>
          <AiSuggestionCompare markdown={markdown} places={layout.places} canAct={canDecide && online} busy={busy} offlineReason={why} decide={decide} />
        </Suspense>
      )}
      {layout.off.map((row) => (
        <div key={row.itemId} className={`ai-bar-row ai-bar-row--${row.state}`}>
          <div className="ai-bar-row-text">
            <span className="ai-bar-who">{row.kind === "comment" ? labelFor.commentBadge(row.agentName) : labelFor.badge(row.agentName)}</span>
            {row.older && <span className="ai-bar-older">{labelFor.older()}</span>}
            <div>{row.state === "changed" ? labelFor.changed() : row.kind === "title" ? labelFor.titleLine(row.text) : row.text}</div>
          </div>
          {canDecide && (
            <span className="ai-bar-actions">
              {row.state === "changed" ? (
                <Button size="sm" variant="secondary" disabled={!canAct} title={why} onClick={() => onDecideRow(row, "reject")}>{labelFor.dismiss()}</Button>
              ) : (
                <>
                  <Button size="sm" variant="primary" disabled={!canAct} title={why} onClick={() => onDecideRow(row, "accept")}>
                    {row.kind === "comment" ? labelFor.markRead() : labelFor.accept()}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={!canAct} title={why} onClick={() => onDecideRow(row, "reject")}>
                    {row.kind === "comment" ? labelFor.dismiss() : labelFor.reject()}
                  </Button>
                </>
              )}
            </span>
          )}
        </div>
      ))}
    </section>
  );
}
