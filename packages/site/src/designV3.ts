// The v3 design: the default, the validator and the move from v2
// (docs/architecture/proposals/site-boxes-2026-11-01.md §4, §6). All pure.
import { isObj } from "./isObj.js";
import { BOX_IDS, BOX_SPECS, isListBox, type BoxId } from "./boxes.js";
import type { BoxPick, HomePresetId, PuckData, SiteBoxes, SiteDesign, SiteDesignV2 } from "./design.js";
import { defaultBoxes, applyHomePreset, DEFAULT_HOME_PRESET, HOME_PRESET_IDS } from "./presets.js";
import { cleanFrames, cleanSiteCss, cleanStyle, validateDesignV2 } from "./validate.js";
import { defaultDesignV2, defaultFrames } from "./defaults.js";
import { WIDGETS, defaultVariantOf, type WidgetRegistry } from "./widgets.js";

export type DesignValidation = { design: SiteDesign; problems: string[] };

/** The design a workspace has until the owner makes one: the 簡單 home page and the 筆記花園 note and tag pages. */
export function defaultDesign(): SiteDesign {
  return {
    v: 3,
    rev: "",
    studio_draft: true,
    preset: DEFAULT_HOME_PRESET,
    boxes: defaultBoxes(DEFAULT_HOME_PRESET),
    style: cleanStyle(undefined, []),
    css: "",
    date_tags: defaultFrames().date_tags,
    reading: { cover: true, preview: true },
    legacy_home: null,
  };
}

/** Whether the old free-form home page is what the home URL draws. */
export const usesLegacyHome = (design: Pick<SiteDesign, "preset" | "legacy_home">): boolean =>
  design.preset === null && design.legacy_home !== null && design.legacy_home.content.length > 0;

/** A pick that names a widget this box takes, with a valid variant; null otherwise. */
export function cleanPick(raw: unknown, box: BoxId, registry: WidgetRegistry = WIDGETS): BoxPick | null {
  if (!isObj(raw) || typeof raw.widget !== "string") return null;
  const widget = registry.get(raw.widget);
  if (!widget || !widget.classes.includes(BOX_SPECS[box].accepts)) return null;
  const variant = typeof raw.variant === "string" && widget.variants.some((x) => x.id === raw.variant) ? raw.variant : defaultVariantOf(widget);
  return { widget: widget.id, variant };
}

function cleanBoxes(raw: unknown, base: SiteBoxes, problems: string[], registry: WidgetRegistry): SiteBoxes {
  const source = isObj(raw) ? raw : {};
  const out: Record<string, BoxPick | BoxPick[] | null> = {};
  for (const id of BOX_IDS) {
    if (!(id in source)) { out[id] = base[id]; continue; }
    const entry = source[id];
    if (isListBox(id)) {
      const list = Array.isArray(entry) ? entry : [];
      const picks = list.flatMap((item) => {
        const pick = cleanPick(item, id, registry);
        if (!pick) problems.push(`${id}: a widget this box does not take was dropped`);
        return pick ? [pick] : [];
      });
      if (picks.length > BOX_SPECS[id].max) problems.push(`${id}: more than ${BOX_SPECS[id].max} widgets, the rest dropped`);
      out[id] = picks.slice(0, BOX_SPECS[id].max);
    } else if (entry === null) {
      out[id] = null;
    } else {
      const pick = cleanPick(entry, id, registry);
      if (!pick) problems.push(`${id}: not a widget this box takes, using the default`);
      out[id] = pick ?? base[id];
    }
  }
  return out as unknown as SiteBoxes;
}

function cleanHome(raw: unknown, problems: string[]): PuckData | null {
  if (!isObj(raw)) return null;
  const { design, problems: found } = validateDesignV2({ v: 2, home: raw });
  problems.push(...found.filter((p: string) => !p.startsWith("not a v2")));
  return design.home;
}

/** Any stored value → a v3 design that satisfies the box rules. A v2 value is
 *  moved (migrateV2); anything else is the default design. Never throws. */
export function validateDesign(input: unknown, registry: WidgetRegistry = WIDGETS): DesignValidation {
  if (isObj(input) && input.v === 2) {
    const { design, problems } = validateDesignV2(input);
    return { design: migrateV2(design), problems };
  }
  if (!isObj(input) || input.v !== 3) return { design: defaultDesign(), problems: ["not a v2 or v3 design: using the default design"] };
  const problems: string[] = [];
  const preset = HOME_PRESET_IDS.find((id) => id === input.preset) ?? null;
  const base = defaultBoxes(preset ?? DEFAULT_HOME_PRESET);
  const legacy = cleanHome(input.legacy_home, problems);
  const reading = isObj(input.reading) ? input.reading : {};
  return {
    design: {
      v: 3,
      rev: typeof input.rev === "string" ? input.rev : "",
      studio_draft: true,
      preset: input.preset === null && legacy && legacy.content.length > 0 ? null : preset ?? DEFAULT_HOME_PRESET,
      boxes: cleanBoxes(input.boxes, base, problems, registry),
      style: cleanStyle(input.style, problems),
      css: cleanSiteCss(input.css, problems),
      date_tags: cleanFrames({ date_tags: input.date_tags }).date_tags,
      reading: { cover: reading.cover !== false, preview: reading.preview !== false },
      legacy_home: legacy,
    },
    problems,
  };
}

// ── v2 → v3 ──────────────────────────────────────────────────────────────

const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical)
  : isObj(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Whether a v2 home page is the one defaultDesignV2 made (whichever note and tag it named) —
 *  the owner never changed it. */
export function isDefaultHome(home: PuckData): boolean {
  const cover = home.content.find((c) => c.props.id === "default-cover");
  const list = home.content.find((c) => c.props.id === "default-list");
  // A pick the owner cleared (noteId / tagId "") is still the default home waiting for a choice, so the
  // expected page is built with a stand-in id and then given the page's own (possibly empty) one.
  const noteId = ((cover?.props.items as Array<{ props: { noteId?: unknown } }> | undefined)?.[0]?.props.noteId as string | undefined) ?? "";
  const tagId = ((list?.props.items as Array<{ props: { tagId?: unknown } }> | undefined)?.[0]?.props.tagId as string | undefined) ?? "";
  const expected = defaultDesignV2({ homeNoteId: cover ? "x" : null, topTagId: list ? "y" : null }).home;
  for (const c of expected.content) {
    const item = (c.props.items as Array<{ props: Record<string, unknown> }>)[0]!;
    if (c.props.id === "default-cover") item.props.noteId = noteId;
    else item.props.tagId = tagId;
  }
  return same(home.content, expected.content);
}

/** The v2 article switches as the one info line. A switch that was off stays off: no variant shows
 *  a date unless `d`, so a design that hid the date never gets it back. */
function metaPick(d: boolean, r: boolean, t: boolean): BoxPick | null {
  const variant = d
    ? (t && r ? "all" : t ? "date-tags" : "date-reading")
    : (t && r ? "reading-tags" : t ? "tags" : r ? "reading" : null);
  return variant ? { widget: "meta", variant } : null;
}

/** A v2 design as v3. A design nobody changed (default home page, default
 *  frames) becomes the new default with its style and date tags. Otherwise the
 *  frame switches become box contents, and a home page the owner changed stays
 *  as `legacy_home`, drawn until they pick a home page style. */
export function migrateV2(v2: SiteDesignV2): SiteDesign {
  const fresh = defaultDesign();
  const common = { rev: v2.rev, style: v2.style, css: v2.css, date_tags: v2.frames.date_tags };
  const framesDefault = same({ article: v2.frames.article, tag: v2.frames.tag }, { article: defaultFrames().article, tag: defaultFrames().tag });
  const homeDefault = isDefaultHome(v2.home);
  if (framesDefault && homeDefault) return { ...fresh, ...common };

  const a = v2.frames.article;
  const g = v2.frames.tag;
  const boxes: SiteBoxes = { ...fresh.boxes };
  boxes.header = a.nav !== false || g.nav !== false ? { widget: "nav", variant: "bar" } : null;
  boxes.foot = a.footer !== false || g.footer !== false ? [{ widget: "copyright", variant: "simple" }, { widget: "rss", variant: "link" }] : [];
  boxes["note.meta"] = metaPick(!!a.date, !!a.readingTime, !!a.tags);
  boxes["note.left"] = a.tree ? { widget: "tree", variant: "tree" } : a.toc ? { widget: "toc", variant: "list" } : null;
  boxes["note.right"] = a.tree && a.toc ? { widget: "toc", variant: "list" } : null;
  boxes["note.end"] = [
    ...(a.backlinks ? [{ widget: "backlinks", variant: "quote" }] : []),
    ...(a.prevnext ? [{ widget: "prevnext", variant: "links" }] : []),
  ];
  boxes["tag.desc"] = g.description ? { widget: "tagdesc", variant: "text" } : null;
  // The old tag page followed the tag's saved view (list, cards or table): keep that.
  boxes["tag.list"] = { widget: "tagnotes", variant: "view" };
  boxes["tag.end"] = [];
  const reading = { cover: a.cover !== false, preview: a.preview !== false };
  if (homeDefault) return { ...fresh, ...common, boxes: { ...boxes, "home.hero": fresh.boxes["home.hero"], "home.list": fresh.boxes["home.list"] }, reading };
  return {
    ...fresh, ...common, preset: null, reading, legacy_home: v2.home,
    boxes: applyHomePreset(boxes, DEFAULT_HOME_PRESET),
  };
}

export type { HomePresetId };
