import { CARD_COLORS } from "../lib/cardColors";
import { t } from "../lib/i18n";
import { Pressable } from "./ui";

/** The card colour choices (and 「Clear colour」) as round swatches: the selected card's
 *  bar and the several-cards bar both pick colours through this one list. */
export default function CardColorSwatches({ onPick }: { onPick: (color: string | null) => void }) {
  return (
    <>
      {CARD_COLORS.map((c) => {
        const label = c.value ? t(c.label) : t("Clear colour");
        return (
          <Pressable key={c.label} type="button" className={`canvas-color-swatch${c.value ? "" : " canvas-color-swatch--clear"}`}
            style={c.value ? ({ "--swatch-bg": c.value } as React.CSSProperties) : undefined}
            title={label} aria-label={label} onClick={() => onPick(c.value)} />
        );
      })}
    </>
  );
}
