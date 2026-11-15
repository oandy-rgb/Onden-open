import { useState, type CSSProperties } from "react";
import { APP_COLOR_PRESETS, DEFAULT_APP_SEED } from "@onden/site/palette";
import { ColorInput, FieldError, Pressable } from "../components/ui";
import { readStoredColors, type ColorSeed } from "../lib/appColors";
import { useT } from "../lib/i18n";
import { chooseColors } from "./appearance";
import { PRESET_LABELS } from "./colorNames";
import "./AppColorsSetting.css";

// Settings › Appearance › Colours: a row of presets and a custom pair of
// pickers. Every choice is two seeds; the colours of both themes follow from
// them (@onden/site palette.ts) and the choice stays on this device, like the
// theme mode. Loaded on demand with the formula (the registry entry is lazy).

const sameSeed = (a: ColorSeed, b: ColorSeed) => a.accent === b.accent && a.paper === b.paper;

export default function AppColorsSetting() {
  const t = useT();
  const [seed, setSeed] = useState<ColorSeed>(() => {
    const stored = readStoredColors();
    return stored ? { accent: stored.accent, paper: stored.paper } : DEFAULT_APP_SEED;
  });
  // The pickers show once "Custom" is chosen, or when the colours match no preset.
  const [customOpen, setCustomOpen] = useState(() => !APP_COLOR_PRESETS.some((p) => sameSeed(p, seed)));
  const [failed, setFailed] = useState(false);

  function choose(next: ColorSeed) {
    setSeed(next);
    void chooseColors(next).then((kept) => setFailed(!kept), () => setFailed(true));
  }
  const matched = APP_COLOR_PRESETS.find((p) => sameSeed(p, seed));
  const customActive = customOpen || !matched;

  return (
    <div className="app-colors">
      <div className="app-colors__swatches" role="group" aria-label={t("Colours")}>
        {APP_COLOR_PRESETS.map((preset) => (
          <Pressable
            key={preset.id}
            className="app-colors__swatch"
            aria-pressed={!customActive && matched?.id === preset.id}
            onClick={() => { setCustomOpen(false); choose({ accent: preset.accent, paper: preset.paper }); }}
          >
            <span className="app-colors__chip" style={{ "--chip-paper": preset.paper, "--chip-accent": preset.accent } as CSSProperties} aria-hidden="true" />
            {t(PRESET_LABELS[preset.id] ?? preset.id)}
          </Pressable>
        ))}
        <Pressable className="app-colors__swatch" aria-pressed={customActive} onClick={() => setCustomOpen(true)}>
          <span className="app-colors__chip" style={{ "--chip-paper": seed.paper, "--chip-accent": seed.accent } as CSSProperties} aria-hidden="true" />
          {t("Custom")}
        </Pressable>
      </div>
      {customActive && (
        <div className="app-colors__custom">
          <label className="app-colors__pick">
            {t("Accent colour")}
            <ColorInput value={seed.accent} onChange={(e) => choose({ ...seed, accent: e.target.value.toLowerCase() })} />
          </label>
          <label className="app-colors__pick">
            {t("Paper colour")}
            <ColorInput value={seed.paper} onChange={(e) => choose({ ...seed, paper: e.target.value.toLowerCase() })} />
          </label>
        </div>
      )}
      {failed && <FieldError>{t("These colours couldn't be applied.")}</FieldError>}
    </div>
  );
}
