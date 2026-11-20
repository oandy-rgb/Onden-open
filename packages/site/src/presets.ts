// The four ready-made home pages and the boxes every page starts with. A home
// page style is only a set of picks for the two home boxes; the rest of the
// site (note page, tag page, header, foot) is the same for all four.
import { BOX_SPECS } from "./boxes.js";
import type { BoxPick, HomePresetId, SiteBoxes } from "./design.js";
import { WIDGETS, defaultVariantOf } from "./widgets.js";

const pick = (widget: string, variant?: string): BoxPick => ({ widget, variant: variant ?? defaultVariantOf(WIDGETS.get(widget)!) });

export const HOME_PRESET_IDS: readonly HomePresetId[] = ["simple", "garden", "newsletter", "index"];

export const HOME_PRESETS: Record<HomePresetId, { label: string; blurb: string; hero: BoxPick | null; list: BoxPick[] }> = {
  simple: {
    label: "簡單", blurb: "自我介紹，下面是最近更新、主題與全部文章",
    hero: pick("intro"), list: [pick("recent"), pick("topics"), pick("all", "byYear")],
  },
  garden: {
    label: "花園", blurb: "自我介紹，主題放前面，全部文章標上成熟度",
    hero: pick("intro"), list: [pick("topics"), pick("all", "maturity")],
  },
  newsletter: {
    label: "電子報", blurb: "訂閱在最前面，接著是最新一篇、精選與最近的文章",
    hero: pick("subscribe"), list: [pick("latest"), pick("featured"), pick("all", "recent10")],
  },
  index: {
    label: "目錄", blurb: "自我介紹，主題，最近 10 篇",
    hero: pick("intro"), list: [pick("topics"), pick("all", "recent10")],
  },
};

export const DEFAULT_HOME_PRESET: HomePresetId = "simple";

/** The boxes of the note, tag and header/foot, the same for every home page style (the 筆記花園 default). */
function baseBoxes(): Omit<SiteBoxes, "home.hero" | "home.list"> {
  return {
    header: pick("nav", "bar"),
    "note.meta": pick("meta", "all"),
    "note.left": pick("tree"),
    "note.right": pick("toc"),
    "note.end": [pick("graph"), pick("backlinks", "quote"), pick("prevnext")],
    "tag.desc": pick("tagdesc"),
    "tag.list": pick("tagnotes", "byYear"),
    "tag.end": [pick("tagfeed")],
    foot: [pick("copyright"), pick("rss"), pick("scheme")],
  };
}

/** `boxes` with the two home boxes set to preset `id`'s picks; the other boxes are kept. */
export function applyHomePreset(boxes: SiteBoxes, id: HomePresetId): SiteBoxes {
  const preset = HOME_PRESETS[id];
  return { ...boxes, "home.hero": preset.hero ? { ...preset.hero } : null, "home.list": preset.list.map((p) => ({ ...p })).slice(0, BOX_SPECS["home.list"].max) };
}

/** Every box of a fresh site, with the home page of preset `id`. */
export function defaultBoxes(id: HomePresetId = DEFAULT_HOME_PRESET): SiteBoxes {
  return applyHomePreset({ ...baseBoxes(), "home.hero": null, "home.list": [] }, id);
}
