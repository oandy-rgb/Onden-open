// 網站設定: what the right column shows when nothing on the canvas is
// selected — the site's name and one-line intro, the three style choices, and
// (folded away) the site-wide CSS. Everything changes the design at once; the
// canvas follows.
import { useId } from "react";
import { bracesBalanced, usesImport, type SiteDesignV2, type SiteStyle } from "@onden/site";
import { useT } from "../../../lib/i18n";
import SiteImageField from "./SiteImageField";
import StyleChoices from "./StyleChoices";
import { TextArea, TextField } from "../../../components/ui";

/** The site's identity: name, tagline and its two pictures (stored `/api/media/…` addresses; "" = none). */
export type SiteInfo = { brand: string; tagline: string; logo: string; favicon: string };

export default function SiteSettingsPanel({ design, onStyle, onCss, info, onInfo }: {
  design: SiteDesignV2;
  onStyle: (style: SiteStyle) => void;
  onCss: (css: string) => void;
  info: SiteInfo;
  onInfo: (patch: Partial<SiteInfo>) => void;
}) {
  const t = useT();
  const ids = { brand: useId(), tagline: useId(), css: useId(), cssHelp: useId() };
  const balanced = bracesBalanced(design.css);
  const importDropped = usesImport(design.css);
  return (
    <div className="hs-style">
      <section className="hs-section">
        <h3 className="hs-section__title">網站</h3>
        <label className="hs-field__label" htmlFor={ids.brand}>網站名稱</label>
        <TextField id={ids.brand} className="hs-input" value={info.brand} onChange={(e) => onInfo({ brand: e.target.value })} />
        <label className="hs-field__label" htmlFor={ids.tagline}>一句話介紹</label>
        <TextField id={ids.tagline} className="hs-input" value={info.tagline} onChange={(e) => onInfo({ tagline: e.target.value })} />
        <SiteImageField label={t("Logo")} value={info.logo} onChange={(logo) => onInfo({ logo })} />
        <SiteImageField label={t("Site icon")} hint={t("The small icon on the browser tab")} value={info.favicon} onChange={(favicon) => onInfo({ favicon })} />
      </section>

      <section className="hs-section">
        <StyleChoices value={design.style} onChange={onStyle} />
      </section>

      <details className="hs-advanced">
        <summary>自己寫樣式</summary>
        <label className="hs-field__label" htmlFor={ids.css}>寫在這裡的樣式會即時套用到整個網站</label>
        <TextArea
          id={ids.css} className="hs-input hs-input--code" rows={8} spellCheck={false} value={design.css}
          aria-invalid={!balanced} aria-describedby={balanced ? undefined : ids.cssHelp}
          onChange={(e) => onCss(e.target.value)}
        />
        {!balanced && <p id={ids.cssHelp} className="hs-warn" role="alert">大括號沒有配對，先不套用</p>}
        {importDropped && <p className="hs-warn" role="status">不支援 @import，含 @import 的那幾行不會套用</p>}
      </details>
    </div>
  );
}
