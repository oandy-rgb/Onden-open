// 進階: what is not part of the everyday choices — the site's own CSS, the old free-form home page
// canvas, and the site's basic settings. Collapsed until opened.
import { useEffect, useState } from "react";
import { SITE_CSS_MAX, bracesBalanced } from "@onden/site";
import { Button, TextArea } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { openSettings } from "../../../lib/settingsRequest";

type Props = { css: string; onCss: (css: string) => void; onOpenLegacy: () => void };

export default function AdvancedSection({ css, onCss, onOpenLegacy }: Props) {
  const t = useT();
  // Typing shows at once; the design takes it after a pause (each change is one autosaved version).
  const [text, setText] = useState(css);
  useEffect(() => { setText(css); }, [css]);
  useEffect(() => {
    if (text === css) return;
    const id = setTimeout(() => onCss(text), 600);
    return () => clearTimeout(id);
  }, [text, css, onCss]);
  const broken = text.length > 0 && !bracesBalanced(text);
  return (
    <details className="ss-advanced">
      <summary>{t("Advanced")}</summary>
      <div className="ss-advanced__body">
        <label>
          <strong>{t("Your own CSS")}</strong>
          <p className="ss-hint">{t("Added to every page of the site.")}</p>
          <TextArea className="ss-advanced__css" value={text} maxLength={SITE_CSS_MAX} spellCheck={false} onChange={(e) => setText(e.target.value)} />
        </label>
        {broken && <p className="ss-hint" role="alert">{t("The braces do not match, so this CSS is not applied.")}</p>}
        <div>
          <Button onClick={onOpenLegacy}>{t("Old home page canvas")}</Button>
          <p className="ss-hint">{t("The free-form home page layout from before. It is kept as it is and gets no new features.")}</p>
        </div>
        <div>
          <Button variant="ghost" onClick={() => openSettings("modules")}>{t("Website settings")}</Button>
          <p className="ss-hint">{t("Language, description, search engines, visitor statistics and your own domain.")}</p>
        </div>
      </div>
    </details>
  );
}
