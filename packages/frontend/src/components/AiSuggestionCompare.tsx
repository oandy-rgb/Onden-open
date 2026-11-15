// "Compare": the note now beside the note with every pending AI suggestion made, one place at a
// time (lib/aiSuggestionCompare.ts cuts the places; TextCompare draws them). A button here asks
// the same decision the in-text buttons ask (useAiSuggestions.decide): nothing reads "accepted"
// until the server took it and the list came back without the place.
import { cutToGraphemes, graphemeCount } from "@onden/markdown";
import { useMemo, useState } from "react";
import { decidePlaces, suggestionCompare } from "../lib/aiSuggestionCompare";
import { labelFor, type Decision, type Place } from "../lib/aiSuggestions";
import { t } from "../lib/i18n";
import { TextCompare, placeTouches, type ComparePlace } from "./compare";
import { Button } from "./ui";

export default function AiSuggestionCompareToggle(props: Parameters<typeof AiSuggestionCompare>[0]) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ai-bar-compare">
      <Button size="sm" variant="ghost" aria-pressed={open} onClick={() => setOpen((v) => !v)}>{t("Compare changes")}</Button>
      {open && <AiSuggestionCompare {...props} />}
    </div>
  );
}

/** A few words of what the suggestion is about: the paragraph it touches, or the text it adds. */
function excerptOf(place: Place, markdown: string): string {
  const text = (place.kind === "insert" ? place.newText ?? "" : markdown.slice(place.from, place.to)).replace(/\s+/g, " ").trim();
  return `“${cutToGraphemes(text, 24)}${graphemeCount(text) > 24 ? "…" : ""}”`;
}

function AiSuggestionCompare({ markdown, places, canAct, busy, offlineReason, decide }: {
  markdown: string;
  /** The pending places the text can show (layout.places). */
  places: readonly Place[];
  /** The person may decide, the connection is up. */
  canAct: boolean;
  /** A decision is on its way to the server. */
  busy: boolean;
  offlineReason?: string;
  /** useAiSuggestions' decide. */
  decide(suggestionId: string, itemIds: string[], decision: Decision): Promise<boolean>;
}) {
  const compare = useMemo(() => suggestionCompare(markdown, places), [markdown, places]);
  const cut = useMemo(() => compare.places.map(({ before, after }) => ({ before, after })), [compare]);
  if (compare.places.length === 0 && compare.spacingOnly.length === 0) return <p className="ai-bar-compare-none">{t("No differences.")}</p>;
  const ownersOf = (place: ComparePlace) => compare.places.filter((p) => placeTouches(place, p.after)).flatMap((p) => p.owners);
  const disabled = !canAct || busy;
  return (
    <>
    {compare.places.length > 0 && <TextCompare
      before={markdown} after={compare.after} places={cut}
      beforeLabel={t("Current text")} afterLabel={t("With the AI's suggestions")}
      placeActions={(place) => {
        const owners = ownersOf(place);
        if (owners.length === 0) return null;
        const disabled = !canAct || busy;
        // One button pair decides one suggestion. A spot the view draws as one block can hold
        // several (neighbouring paragraphs merge into one block), so each is listed on its own.
        const buttons = (own: readonly Place[]) => (
          <>
            <Button size="sm" variant="primary" disabled={disabled} title={offlineReason} aria-busy={busy || undefined} onClick={() => void decidePlaces(own, "accept", decide)}>{labelFor.accept()}</Button>
            <Button size="sm" variant="secondary" disabled={disabled} title={offlineReason} onClick={() => void decidePlaces(own, "reject", decide)}>{labelFor.reject()}</Button>
          </>
        );
        if (owners.length === 1) return buttons(owners);
        return (
          <ul className="ai-compare-owners">
            {owners.map((owner) => (
              <li key={owner.itemId} className="ai-compare-owner">
                <span className="ai-compare-owner-text">{excerptOf(owner, markdown)}</span>
                {buttons([owner])}
              </li>
            ))}
          </ul>
        );
      }}
    />}
    {compare.spacingOnly.length > 0 && (
      <ul className="ai-compare-owners">
        {compare.spacingOnly.map((place) => (
          <li key={place.itemId} className="ai-compare-owner">
            <span className="ai-compare-owner-text">{labelFor.spacingHint()} {excerptOf(place, markdown)}</span>
            <Button size="sm" variant="primary" disabled={disabled} title={offlineReason} onClick={() => void decidePlaces([place], "accept", decide)}>{labelFor.accept()}</Button>
            <Button size="sm" variant="secondary" disabled={disabled} title={offlineReason} onClick={() => void decidePlaces([place], "reject", decide)}>{labelFor.reject()}</Button>
          </li>
        ))}
      </ul>
    )}
    </>
  );
}
