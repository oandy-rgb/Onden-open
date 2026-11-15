import { Sparkles } from "lucide-react";
import { t, tn } from "../../lib/i18n";
import type { NoteFunctionEnv, NoteFunctionRow } from "../types";
import { aiLabel } from "../../lib/actorLabel";
import { scrollToSuggestionBar } from "../../lib/noteChatDom";
import { ellipsize } from "@onden/markdown";
import { labelFor } from "../../lib/aiSuggestions";
import type { SuggestionItem } from "@onden/contract";

const excerpt = (text: string, max = 16): string => ellipsize(text.replace(/\s+/g, " ").trim(), max);

/** One short line about a waiting place. */
function placeSummary(item: SuggestionItem): string {
  switch (item.kind) {
    case "title": return item.new_text ? labelFor.titleLine(excerpt(item.new_text, 24)) : t("A new title");
    case "delete": return t("Remove “{text}”", { text: excerpt(item.base_text) });
    case "insert": return t("Add after “{text}”", { text: excerpt(item.base_text) });
    case "comment": return t("A comment on “{text}”", { text: excerpt(item.base_text) });
    default: return t("Rewrite “{text}”", { text: excerpt(item.base_text) });
  }
}

/** The 「AI」 row of the 「功能」 tab: the places an AI proposed for this note that wait for the person
 *  (the note's suggestion bar, hooks/useAiSuggestions). No waiting place, no row. */
export default function aiNoteFunctionRows({ suggestions, canEdit, online, nav }: NoteFunctionEnv): NoteFunctionRow[] {
  if (!suggestions || suggestions.pending === 0) return [];
  const { pending, items, acceptAll } = suggestions;
  return [{
    id: "ai",
    Icon: Sparkles,
    name: aiLabel(),
    related: true,
    status: tn("1 place waits for your decision", "{n} places wait for your decision", pending),
    badge: { n: pending, alert: true },
    details: items.map(placeSummary),
    action: canEdit && online ? { label: t("Accept all"), run: acceptAll } : undefined,
    jump: { label: t("Show the first one"), run: () => { nav.showContent?.(); scrollToSuggestionBar(); } },
  }];
}
