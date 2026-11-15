// The site's three style choices: 氣質 (the temperament), 重點色, 配色. The
// desktop settings panel and the phone studio both draw this; everything else
// about the look is computed from these three (@onden/site style.ts).
import { useId, type CSSProperties } from "react";
import { ACCENT_SWATCHES, FONT_STACKS, SCHEMES, SCHEME_LABELS, STYLE_PRESETS, STYLE_PRESET_NAMES, type SiteStyle } from "@onden/site";
import "./StyleChoices.css";
import { ColorInput, Pressable } from "../../../components/ui";

const SWATCH_NAMES: Record<(typeof ACCENT_SWATCHES)[number], string> = {
  "#3f7d6e": "綠", "#b23a2a": "紅", "#2a5bd7": "藍", "#b0489a": "紫", "#e8772e": "橘", "#f2c230": "黃",
};
const isSwatch = (color: string) => (ACCENT_SWATCHES as readonly string[]).includes(color);

export default function StyleChoices({ value, onChange }: { value: SiteStyle; onChange: (value: SiteStyle) => void }) {
  const customId = useId();
  const customAccent = !isSwatch(value.accent);
  return (
    <div className="sc">
      <section className="sc-group">
        <h3 className="sc-title">氣質</h3>
        <div className="sc-presets" role="group" aria-label="氣質">
          {STYLE_PRESET_NAMES.map((name) => {
            const preset = STYLE_PRESETS[name];
            return (
              <Pressable
                key={name} type="button" className="sc-preset"
                style={{ "--head-font": FONT_STACKS[preset.head], "--head-weight": preset.headWeight, "--body-font": FONT_STACKS[preset.body] } as CSSProperties} aria-pressed={value.preset === name}
                onClick={() => onChange({ ...value, preset: name })}
              >
                <span className="sc-preset__name">{preset.label}</span>
                <span className="sc-preset__blurb">{preset.blurb}</span>
              </Pressable>
            );
          })}
        </div>
      </section>

      <section className="sc-group">
        <h3 className="sc-title">重點色</h3>
        <div className="sc-swatches" role="group" aria-label="重點色">
          {ACCENT_SWATCHES.map((color) => (
            <Pressable
              key={color} type="button" className="sc-swatch" style={{ "--swatch": color } as CSSProperties}
              aria-label={SWATCH_NAMES[color]} aria-pressed={value.accent === color} onClick={() => onChange({ ...value, accent: color })}
            />
          ))}
          <label className="sc-custom" data-active={customAccent ? "" : undefined} htmlFor={customId}>
            <ColorInput
              id={customId} className="sc-custom__input" value={value.accent}
              onChange={(e) => onChange({ ...value, accent: e.target.value.toLowerCase() })}
            />
            <span className="sc-custom__dot" style={{ "--swatch": value.accent } as CSSProperties} aria-hidden="true" />
            自訂
          </label>
        </div>
      </section>

      <section className="sc-group">
        <h3 className="sc-title">配色</h3>
        <div className="sc-schemes" role="group" aria-label="配色">
          {SCHEMES.map((scheme) => (
            <Pressable
              key={scheme} type="button" className="sc-scheme" aria-pressed={value.scheme === scheme}
              onClick={() => onChange({ ...value, scheme })}
            >{SCHEME_LABELS[scheme]}</Pressable>
          ))}
        </div>
      </section>
    </div>
  );
}
