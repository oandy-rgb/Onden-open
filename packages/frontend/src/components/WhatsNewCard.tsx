import { X } from "lucide-react";
import { useT, getLocale } from "../lib/i18n";
import { openSettings } from "../lib/settingsRequest";
import { changeText, type Change } from "../lib/whatsNewText";
import { Button } from "./ui";

/** How many changes the card lists; the rest are behind 「看全部」. */
export const WHATS_NEW_CARD_MAX = 3;

/** 「這次更新」: a small card in the device notices (no dialog) listing what is new
 *  since this account last looked. Closing it, or opening the full list in
 *  Settings, marks everything seen. `compact` (a phone) is one line, 「有新功能 ›」,
 *  that opens the full list instead of a card over the content. */
export default function WhatsNewCard({ unseen, onSeen, compact = false }: { unseen: readonly Change[]; onSeen: () => void; compact?: boolean }) {
  const t = useT();
  const locale = getLocale();
  if (unseen.length === 0) return null;
  const shown = unseen.slice(0, WHATS_NEW_CARD_MAX);
  const seeAll = () => { onSeen(); openSettings("about"); };
  if (compact) return <p className="device-notice device-notice--action" aria-label={t("What's new")}>
    <Button type="button" onClick={seeAll}>{t("New features")} ›</Button>
  </p>;
  return <section className="device-notice-card" aria-label={t("What's new")}>
    <header className="device-notice-card-head">
      <h2>{t("What's new")}</h2>
      <Button variant="icon" size="sm" aria-label={t("Dismiss")} onClick={onSeen}><X size={14} /></Button>
    </header>
    <ul>
      {shown.map((change) => <li key={change.id}>{changeText(change, locale)}</li>)}
    </ul>
    {unseen.length > shown.length && <Button variant="ghost" size="sm" onClick={seeAll}>{t("See all")}</Button>}
  </section>;
}
