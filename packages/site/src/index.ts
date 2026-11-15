// @onden/site — the website design: types, validation, defaults, style and CSS
// tools. No React and no Puck here; the backend imports this entry.
// React / Puck: "@onden/site/react".
export type { BoxPick, FontKind, HomePresetId, PuckComponentData, PuckData, SiteBoxes, SiteDesign, SiteDesignV2, SiteFrames, SiteScheme, SiteStyle, StylePresetName } from "./design.js";
export * from "./registry.js";
export { validateDesignV2, type DesignValidationV2 } from "./validate.js";
export { cleanPick, defaultDesign, isDefaultHome, migrateV2, usesLegacyHome, validateDesign, type DesignValidation } from "./designV3.js";
export { legacyDesignOf, withLegacyDesign } from "./legacy.js";
export { BOX_IDS, BOX_SPECS, isListBox, picksOf, withBox, type BoxClass, type BoxId, type BoxPage, type BoxSpec, type NarrowFold } from "./boxes.js";
export {
  BUILTIN_WIDGETS, FEATURED_TAGS, MATURITY_TAGS, NO_FACTS, TOC_MIN_HEADINGS, WIDGETS, createWidgetRegistry, defaultVariantOf, widgetReady,
  type WidgetDef, type WidgetFacts, type WidgetRegistry, type WidgetVariant,
} from "./widgets.js";
export { DEFAULT_HOME_PRESET, HOME_PRESETS, HOME_PRESET_IDS, applyHomePreset, defaultBoxes } from "./presets.js";
export type { FrozenDesign, SiteRow, SiteTagPage, ViewKind } from "./rows.js";
export { walkHome, type WalkInfo } from "./walk.js";
export { defaultDesignV2, defaultFrames, ARTICLE_FRAME_KEYS, TAG_FRAME_KEYS, DEFAULT_DATE_TAGS, type DefaultDesignInput } from "./defaults.js";
export {
  ACCENT_SWATCHES, DEFAULT_ACCENT, FONT_STACKS, SCALE_STEPS, SCALE_VIEWPORT, SCHEMES, SCHEME_LABELS, SPACE_LINES,
  STYLE_PRESETS, STYLE_PRESET_NAMES, colorVars, contrastRatio, schemeColors, stepRange, styleCss, styleVars,
  type SchemeColors, type SchemeMode, type StylePreset, type StyleVarOptions,
} from "./style.js";
export { bracesBalanced, sanitizeSiteCss, scopedCss, SITE_CSS_MAX, SITE_SCOPE, usesImport } from "./css.js";
export { expandPattern, patternDefaultSlots } from "./patterns.js";
export { implicitStackId, withImplicitStacks } from "./topLevel.js";
