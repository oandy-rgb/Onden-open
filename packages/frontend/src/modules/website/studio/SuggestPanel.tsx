// 建議: what the studio noticed (suggestions.ts). Nothing here changes the page
// by itself: 預覽 shows the result on the canvas with 套用／取消, and the apply
// button does the change.
import type { Suggestion } from "./suggestions";
import EmptyState from "../../../components/EmptyState";
import { Pressable } from "../../../components/ui";

export default function SuggestPanel({ suggestions, previewId, busy, onPreview, onApply }: {
  suggestions: readonly Suggestion[];
  previewId: string | null;
  busy: boolean;
  onPreview: (suggestion: Suggestion) => void;
  onApply: (suggestion: Suggestion) => void;
}) {
  if (suggestions.length === 0) return <EmptyState size="inline" title="目前沒有建議，這一頁看起來沒問題。" />;
  return (
    <ul className="hs-suggestions">
      {suggestions.map((suggestion) => {
        const previewable = suggestion.design !== undefined || suggestion.includeNoteIds !== undefined;
        return (
          <li key={suggestion.id} className="hs-suggestion" data-active={suggestion.id === previewId ? "" : undefined}>
            <p>{suggestion.text}</p>
            <div className="hs-suggestion__actions">
              {previewable && <Pressable type="button" className="hs-button" onClick={() => onPreview(suggestion)}>預覽</Pressable>}
              {suggestion.applyLabel && (
                <Pressable type="button" className="hs-button hs-button--primary" disabled={busy} onClick={() => onApply(suggestion)}>{suggestion.applyLabel}</Pressable>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
