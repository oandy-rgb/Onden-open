import type { CSSProperties } from "react";
import { useT } from "../lib/i18n";
import { INK_PALETTE, QUICK_SLOTS, paletteLabel, type InkPaletteState } from "../lib/ink";
import InkColorPicker from "./InkColorPicker";
import { Pressable } from "./ui";

// The full colour panel behind the toolbar's 「更多」 button: the palette,
// colours the person made or used lately, a palette (square, hue bar, colour
// code, eyedropper) for any other, and a way to change which five colours sit
// in the toolbar.

export function ColorSwatch({ color, active, onPick }: { color: string; active: boolean; onPick: (color: string) => void }) {
  const t = useT();
  const name = paletteLabel(color);
  return (
    <Pressable
      type="button"
      className={active ? "ink-swatch active" : "ink-swatch"}
      onClick={() => onPick(color)}
      aria-pressed={active}
      aria-label={name ? t(name) : color}
      title={name ? t(name) : color}
      style={{ "--ink-swatch-color": color } as CSSProperties}
    />
  );
}

export default function InkColorPanel({
  color, palette, onPick, onLive, onCustom, onQuickSlot, onEyedropper,
}: {
  color: string;
  palette: InkPaletteState;
  /** A colour from the palette or the lists was chosen. */
  onPick: (color: string) => void;
  /** The palette is being dragged, or a colour code typed: the pen colour follows, nothing is kept yet. */
  onLive: (color: string) => void;
  /** The palette was let go of, or a colour code finished: use it and keep it. */
  onCustom: (color: string) => void;
  /** The current colour goes into quick slot `slot`. */
  onQuickSlot: (slot: number) => void;
  /** Start picking a colour from the page (the eyedropper next to the palette). */
  onEyedropper?: () => void;
}) {
  const t = useT();
  const same = (a: string) => a.toLowerCase() === color.toLowerCase();
  const section = (title: string, colors: string[]) => colors.length > 0 && (
    <section className="ink-color-section">
      <h3>{title}</h3>
      <div className="ink-palette-grid" role="group" aria-label={title}>
        {colors.map((c) => <ColorSwatch key={c} color={c} active={same(c)} onPick={onPick} />)}
      </div>
    </section>
  );
  return (
    <div className="ink-color-panel" data-ink-color-panel="">
      {section(t("Colors"), INK_PALETTE.map((c) => c.value))}
      {section(t("My colors"), palette.custom)}
      {section(t("Recent"), palette.recent)}
      <section className="ink-color-section">
        <h3>{t("Custom color")}</h3>
        <InkColorPicker color={color} onLive={onLive} onKeep={onCustom} onEyedropper={onEyedropper} />
      </section>
      <section className="ink-color-section">
        <h3>{t("Replace a quick color with the current one")}</h3>
        <div className="ink-palette-grid" role="group" aria-label={t("Quick colors")}>
          {Array.from({ length: QUICK_SLOTS }, (_, slot) => (
            <Pressable
              key={slot}
              type="button"
              className="ink-swatch ink-swatch--slot"
              onClick={() => onQuickSlot(slot)}
              aria-label={t("Replace quick color {n}", { n: slot + 1 })}
              title={t("Replace quick color {n}", { n: slot + 1 })}
              style={{ "--ink-swatch-color": palette.quick[slot] } as CSSProperties}
              data-ink-quick-slot={slot}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
