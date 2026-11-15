// The choices of the appearance settings before 設定改版, read as the new ones. A new setting
// reads its own key first and falls back to these, so what a person already chose looks the
// same afterwards; the old keys are never rewritten or deleted.
//
//   基準字級 (theme.font_size, px) + 介面密度 (theme.density)  →  介面大小 (theme.ui_size)
//   內文大小 (note.text_scale, "80".."150")                    →  文字大小 (note.text_size)
//   編輯器字體 (theme.editor_font) / 內文字型 (account `fonts`) →  字體 (note.font)
//   減少動態 (theme.reduce_motion, "true"/"false")             →  減少動態 (theme.motion)
//   標題大小 (note.title_size) is gone: titles scale with the text.

export const UI_SIZES = ["small", "normal", "large"] as const;
export type UiSize = (typeof UI_SIZES)[number];

export const NOTE_TEXT_SIZES = ["xs", "s", "m", "l", "xl"] as const;
export type NoteTextSize = (typeof NOTE_TEXT_SIZES)[number];

export const MOTION_MODES = ["system", "reduce", "full"] as const;
export type MotionMode = (typeof MOTION_MODES)[number];

/** A base size of 12px or less, or a compact density, was the small interface; 16px or more, or
 *  a spacious density, the large one. The size wins when both point somewhere. */
export function uiSizeFromLegacy(fontSizePx: number | null, density: string | null): UiSize {
  if (fontSizePx !== null && fontSizePx <= 12) return "small";
  if (fontSizePx !== null && fontSizePx >= 16) return "large";
  if (density === "compact") return "small";
  if (density === "spacious") return "large";
  return "normal";
}

/** The old text sizes were 80/90/100/110/125/150 percent: the nearest of the five steps. */
export function noteTextSizeFromLegacy(percent: number | null): NoteTextSize {
  if (percent === null) return "m";
  if (percent <= 85) return "xs";
  if (percent <= 95) return "s";
  if (percent <= 105) return "m";
  if (percent <= 117) return "l";
  return "xl";
}

export function motionFromLegacy(reduceMotion: string | null): MotionMode {
  return reduceMotion === "true" ? "reduce" : "system";
}
