// The end button of a focus bar: 「結束專注」, or 「今天到此為止」 while a break runs. Shared by the phone's bar and the 今天 page's.

import { Button } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { endRunHere, openFocusEnding } from "../../../lib/focus";

export default function FocusEndButton({ onBreak }: { onBreak: boolean }) {
  const t = useT();
  return onBreak
    ? <Button size="sm" variant="secondary" onClick={() => endRunHere()}>{t("That's it for today")}</Button>
    : <Button size="sm" variant="secondary" onClick={() => openFocusEnding()}>{t("End focus")}</Button>;
}
