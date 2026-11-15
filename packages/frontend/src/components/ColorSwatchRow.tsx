import type { CSSProperties } from "react";
import { CARD_COLORS } from "../lib/cardColors";
import { t } from "../lib/i18n";
import "./ContextMenu.css";
import { Pressable } from "./ui";

/** The colour swatches of lib/cardColors in one row: a card's colour on a
 *  board, a note's colour in the sidebar menu and the ⌘K colour dialog.
 *  `onPick(null)` is 「Default」: clear the colour. */
export default function ColorSwatchRow({ onPick }: { onPick: (color: string | null) => void }) {
  return (
    <div className="ctx-color-row">
      {CARD_COLORS.map((c) => (
        <Pressable
          key={c.label}
          type="button"
          className="ctx-color-swatch"
          style={c.value ? ({ "--swatch-bg": c.value, "--swatch-border": c.value } as CSSProperties) : undefined}
          title={t(c.label)}
          aria-label={t(c.label)}
          onClick={() => onPick(c.value)}
        />
      ))}
    </div>
  );
}
