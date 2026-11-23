// The scale of direction A 「安靜」, machine-readable. The human version (what each level is FOR, the old → new
// mapping, which kinds have a guard today) is docs/agents/appearance-rules.md; selftest.mjs fails when a kind here
// has no row there. Levels are COMPUTED values (px at the default 14px base font), so they are what the census sees.
//
//   classify(kind, value, ctx) → { on: boolean, why?: string, to?: string }
//   ctx = { coarse: boolean (touch screen), tokens: { colour|shadow|z: reverse maps from the page } }
import { ICON_SIZE_LEVELS, ICON_STROKE_LEVELS } from "../../scripts/appearanceLook.mjs"; // the guard's levels: one list

export const A_TOKENS_KEPT = {
  colour: ["--ac-bg", "--ac-surface", "--ac-elevated", "--ac-hover", "--ac-selected", "--ac-line", "--ac-ink", "--ac-muted",
    "--ac-accent", "--ac-accent-ink", "--ac-accent-soft", "--ac-focus", "--ac-link", "--ac-selection",
    "--ac-danger", "--ac-danger-soft", "--ac-warning", "--ac-success", "--ac-info", "--ac-code-bg",
    "--ac-overlay-hover", "--ac-overlay-selected", "--ac-overlay-press", "--ac-scrim",
    // user content, not chrome: highlight colours, a PDF page and a photo stay as they are
    "--ac-hl-yellow", "--ac-hl-red", "--ac-hl-green", "--ac-hl-blue", "--ac-hl-purple", "--ac-hl-orange",
    "--ac-pure-black", "--ac-pure-white", "--ac-pdf-highlight", "--ac-pdf-highlight-solid", "--ac-pdf-area-fill", "--ac-pdf-area-edge"],
  shadow: ["--ac-shadow-float", "--ac-shadow-modal", "--ac-shadow-sheet", "--ac-ring", "--ac-ring-focus", "--ac-focus-ring", "--ac-bar-start", "--ac-bar-bottom", "--ac-edge-up"],
  // Where the layers stay; the page-level ones are fewer than today (see the rules document for the mapping).
  z: ["--z-base", "--z-local-1", "--z-local-2", "--z-local-3", "--z-local-4", "--z-sticky", "--z-dropdown", "--z-bar", "--z-kb-toolbar",
    "--z-floating-panel", "--z-bar-over-dock", "--z-toast", "--z-popover", "--z-drawer", "--z-gate"],
};

const near = (v, list, tol) => list.find((l) => Math.abs(l - v) <= tol);
const px = (s) => Number.parseFloat(s);

/** Plain numeric scales: the allowed levels and the rounding that counts as "the same". */
export const LEVELS = {
  "font-size": { levels: [12, 13, 14, 16, 20, 24, 34], tol: 0.1, unit: "px" },
  "font-weight": { levels: [400, 600, 700], tol: 0, unit: "" },
  "line-height": { levels: [1, 1.3, 1.5, 1.8], tol: 0.02, unit: "" },       // ratio to the element's own font-size
  "letter-spacing": { levels: [0, 0.04, -0.02], tol: 0.005, unit: "em" },
  spacing: { levels: [2, 4, 8, 12, 16, 24, 32, 48], tol: 0.01, unit: "px" },
  radius: { levels: [4, 8, 12], tol: 0.01, unit: "px" },                    // 0 is ignored, pill = ≥ 99px or 50%
  "border-width": { levels: [1, 2, 3], tol: 0.01, unit: "px" },
  "icon-size": { levels: ICON_SIZE_LEVELS, tol: 0.1, unit: "px" },
  "icon-stroke": { levels: ICON_STROKE_LEVELS, tol: 0.01, unit: "" },
  "control-height": { levels: [28, 32], tol: 0.5, unit: "px", coarse: [44] },
  "max-width": { levels: [320, 400, 560, 640, 720], tol: 0.5, unit: "px" },
  opacity: { levels: [0, 0.5, 0.7], tol: 0.02, unit: "" },                  // 1 is ignored
  "transition-ms": { levels: [0, 120, 200], tol: 0, unit: "ms" },
};

export const KINDS = [
  { id: "colour", label: "顏色", guard: "fe-css-color（只擋寫死的顏色，不擋用哪個 token）" },
  { id: "font-size", label: "字級", guard: "fe-css-font-size（只擋寫死的數字，不擋 token 的個數）" },
  { id: "font-weight", label: "字重", guard: "fe-css-font-weight（只擋數量變多的基準，見規則文件 §三）" },
  { id: "line-height", label: "行高", guard: "fe-css-line-height（只擋數量變多的基準，見規則文件 §三）" },
  { id: "letter-spacing", label: "字距", guard: "fe-css-letter-spacing（只擋數量變多的基準，見規則文件 §三）" },
  { id: "font-family", label: "字體", guard: "fe-css-font-family（只擋數量變多的基準，見規則文件 §三）" },
  { id: "spacing", label: "間距（padding／margin／gap）", guard: "fe-css-spacing（只擋數量變多的基準，見規則文件 §三）" },
  { id: "radius", label: "圓角", guard: "fe-css-radius" },
  { id: "border-width", label: "邊框粗細", guard: "fe-css-border-width（只擋數量變多的基準，見規則文件 §三）" },
  { id: "border-style", label: "邊框樣式", guard: null },
  { id: "border-where", label: "邊框出現的位置", guard: null },
  { id: "shadow", label: "陰影", guard: "fe-css-shadow" },
  { id: "control-height", label: "控制項高度（畫出來的）", guard: "fe-css-control-height（只擋數量變多的基準，見規則文件 §三）" },
  { id: "tap-target", label: "觸控目標（實際可點的大小，只在觸控螢幕量）", guard: "tap-target 基準（scripts/tap-target-baseline.json，只減不增；style:census -- --check-taps）" },
  { id: "icon-size", label: "圖示尺寸", guard: "fe-icon-size（只擋數量變多的基準，見規則文件 §三）" },
  { id: "icon-stroke", label: "圖示線寬", guard: "fe-icon-stroke（只擋數量變多的基準，見規則文件 §三）" },
  { id: "z-index", label: "層級", guard: "fe-css-z-index" },
  { id: "max-width", label: "最大寬度（文字欄與容器）", guard: "fe-css-max-width（只擋數量變多的基準，見規則文件 §三）" },
  { id: "opacity", label: "透明度", guard: "fe-css-opacity（只擋數量變多的基準，見規則文件 §三）" },
  { id: "transition-ms", label: "動畫時間", guard: "fe-css-duration、fe-css-easing（只擋數量變多的基準，見規則文件 §三）" },
  { id: "focus-ring", label: "焦點框", guard: "fe-css-focus-ring（只擋數量變多的基準，見規則文件 §三）" },
];
export const KIND_IDS = KINDS.map((k) => k.id);

const FAMILY_NAMES = ["sans", "serif", "mono", "kai"];

export function classify(kind, value, ctx = { coarse: false, tokens: {} }) {
  const L = LEVELS[kind];
  switch (kind) {
    case "font-family":
      return FAMILY_NAMES.includes(value) ? { on: true } : { on: false, why: "不是 sans／serif／mono／kai 四種之一" };
    case "colour": {
      if (value === "transparent") return { on: true };
      if (value.startsWith("alpha:")) return { on: false, why: "token 加透明度疊出來的顏色（A 只用 token 本身）", to: value.slice(6).split("@")[0] };
      if (!value.startsWith("token:")) return { on: false, why: "沒有對應的 --ac-* token" };
      const name = value.slice(6);
      return A_TOKENS_KEPT.colour.includes(name) ? { on: true } : { on: false, why: "token 在 A 裡併入別的顏色", to: name };
    }
    case "shadow": {
      if (value === "none") return { on: true };
      if (!value.startsWith("token:")) return { on: false, why: "沒有對應的 token" };
      return A_TOKENS_KEPT.shadow.includes(value.slice(6)) ? { on: true } : { on: false, why: "token 在 A 裡取消或併入", to: value.slice(6) };
    }
    case "z-index": {
      if (!value.startsWith("token:")) return { on: false, why: "沒有對應的 --z-* token" };
      return A_TOKENS_KEPT.z.includes(value.slice(6)) ? { on: true } : { on: false, why: "層級在 A 裡併入", to: value.slice(6) };
    }
    case "border-style":
      return value === "solid" || value === "dashed" ? { on: true } : { on: false, why: "只准 solid（分隔、欄位）與 dashed（放開檔案的位置）" };
    case "border-where":
      return value.startsWith("ok:") ? { on: true } : { on: false, why: value.slice(4) };
    case "focus-ring":
      return value.startsWith("ok:") ? { on: true } : { on: false, why: value.slice(4) };
    case "radius": {
      if (value === "pill") return { on: true };
      const n = px(value);
      return near(n, L.levels, L.tol) !== undefined ? { on: true } : { on: false, why: "不是 4／8／12／膠囊" };
    }
    case "control-height": {
      const n = px(value);
      const ok = ctx.coarse ? [...L.coarse] : L.levels;
      return near(n, ok, L.tol) !== undefined ? { on: true } : { on: false, why: ctx.coarse ? "觸控螢幕要 44" : "桌面要 28 或 32" };
    }
    case "icon-size": {
      const n = px(value);
      if (n > 32) return { on: true }; // an illustration, not an icon
      return near(n, L.levels, L.tol) !== undefined ? { on: true } : { on: false, why: "圖示只有 12／16／20／24" };
    }
    case "tap-target":
      return px(value) >= 43.5 ? { on: true } : { on: false, why: "可點的範圍有一邊不到 44" };
    case "transition-ms":
      return near(px(value), L.levels, L.tol) !== undefined ? { on: true } : { on: false, why: "只有 120／200 毫秒" };
    default: {
      if (!L) return { on: true };
      const n = px(value);
      return Number.isFinite(n) && near(n, L.levels, L.tol) !== undefined ? { on: true } : { on: false, why: `不在 ${L.levels.join("／")}` };
    }
  }
}
