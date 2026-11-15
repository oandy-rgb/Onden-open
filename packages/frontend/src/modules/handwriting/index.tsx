// Handwriting (手寫) — a built-in module (docs/agents/decisions-modules.md): the
// pen's settings on the whiteboard and in notes, and any note's 「手寫」 tab (noteView; backend twin: modules/handwriting).
// Always on; it has no switch and no screen, only
// its page, Settings › 手寫 (the ink toolbar's ⋯ opens the same page). The
// engine is lib/ink; the device's two input settings are lib/inkInputPrefs (rules in lib/ink/inputPolicy.ts).

import { PenLine } from "lucide-react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { DEFAULT_AUTO_SHAPE, inkAutoShapePref } from "../../lib/inkPrefs";
import {
  getFingerSetting, getPenSetting, setFingerSetting, setPenSetting, subscribeInkInputPrefs,
  type FingerSetting, type PenSetting,
} from "../../lib/inkInputPrefs";
import type { BuiltInModule } from "../types";

// The note's 「手寫」 tab (layout "handwriting"): its screen and the pen's code load when the tab opens.
const HandwritingPane = lazyWithReload(() => import("./HandwritingPane"));

export const handwritingModule: BuiltInModule = {
  id: "handwriting",
  noteView: { Pane: HandwritingPane, fillsHeight: true, title: "Handwriting", Icon: PenLine },
  settings: [
    {
      id: "handwriting.auto_shape",
      tab: "handwriting",
      label: "Turn a held stroke into a shape",
      description: "Hold the pen still for half a second and the stroke becomes a clean shape.",
      keywords: ["shape", "snap", "auto", "straighten", "line", "circle", "rectangle", "handwriting", "pen", "形狀", "修成", "自動", "手寫", "直線", "圓形"],
      type: "boolean",
      default: DEFAULT_AUTO_SHAPE,
      get: () => inkAutoShapePref.store.get().value ?? DEFAULT_AUTO_SHAPE,
      set: (v) => inkAutoShapePref.store.save(v),
      subscribe: (listener) => inkAutoShapePref.store.subscribe(listener),
    },
    {
      id: "handwriting.pen",
      tab: "handwriting",
      label: "Stylus pen",
      description: "On this device only.",
      keywords: ["pen", "stylus", "s pen", "pencil", "draw", "觸控筆", "手寫筆", "一碰就畫"],
      type: "enum",
      default: "draws" satisfies PenSetting,
      options: [
        { value: "draws", label: "Draws as soon as it touches" },
        { value: "toolbar", label: "Follows the toolbar" },
      ],
      get: getPenSetting,
      set: (v) => setPenSetting(v as PenSetting),
      subscribe: subscribeInkInputPrefs,
    },
    {
      id: "handwriting.finger",
      tab: "handwriting",
      label: "Finger input",
      description: "On this device only. The More menu on a page has the same switch.",
      keywords: ["finger", "touch", "scroll", "draw", "手指", "捲動", "觸控"],
      type: "enum",
      default: "toolbar" satisfies FingerSetting,
      options: [
        { value: "scroll", label: "Only scrolls" },
        { value: "toolbar", label: "Follows the toolbar" },
      ],
      get: getFingerSetting,
      set: (v) => setFingerSetting(v as FingerSetting),
      subscribe: subscribeInkInputPrefs,
    },
  ],
};
