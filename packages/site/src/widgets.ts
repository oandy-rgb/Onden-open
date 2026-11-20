// The widget registry (docs/architecture/proposals/site-boxes-2026-11-01.md §3): the things a box can hold.
// A widget is data here — id, the box classes that take it, its looks (variants),
// and what the site must have for it to draw anything. The drawing of each is
// the frontend's (components/siteFrame/SiteWidgets.tsx). A feature module that
// wants a widget of its own (the reader's RSS → a blogroll) passes its
// definitions to `createWidgetRegistry`; nothing else changes.
import type { BoxClass } from "./boxes.js";
import type { SiteScheme } from "./design.js";

export type WidgetVariant = { id: string; label: string };

/** What the site and the page being drawn have; `ready` reads it. A page-level fact is 0/false where the page is not drawn. */
export type WidgetFacts = {
  /** The home note, or a note called 關於／About, has a first paragraph. */
  introNote: boolean;
  /** Published notes that count as articles (not the home note, not tag pages). */
  articles: number;
  /** Tags with a page on the site. */
  topics: number;
  /** Articles tagged 精選／Featured. */
  featured: number;
  scheme: SiteScheme;
  /** Headings of the article. */
  headings: number;
  /** Footnote definitions of the article. */
  footnotes: number;
  /** Published notes that link to the article. */
  backlinks: number;
  /** Published notes the article links to or that link to it (the graph's neighbours). */
  linked: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** Some published note sits under another. */
  hasTree: boolean;
  /** The tag's own note has a body. */
  tagDescription: boolean;
};

export const NO_FACTS: WidgetFacts = {
  introNote: false, articles: 0, topics: 0, featured: 0, scheme: "system",
  headings: 0, footnotes: 0, backlinks: 0, linked: 0, hasPrev: false, hasNext: false, hasTree: false, tagDescription: false,
};

export type WidgetDef = {
  id: string;
  label: string;
  /** One plain sentence for the choice list. */
  blurb: string;
  /** The box classes that take it. */
  classes: readonly BoxClass[];
  /** Its looks; the first is the default. At least one. */
  variants: readonly WidgetVariant[];
  /** What it needs, worded for the owner ("需要一篇「關於」筆記"); with `ready`, it draws nothing until the site has it. */
  needs?: string;
  ready?: (facts: WidgetFacts) => boolean;
  /** Overrides the box's narrow-screen fold for this widget. */
  narrow?: "hide";
  /** The feature module that provides it; absent for the built-in ones. */
  module?: string;
};

/** Tags that mark a note as featured / by growth stage (names, so no new property is needed). */
export const FEATURED_TAGS = ["精選", "Featured", "featured"] as const;
export const MATURITY_TAGS = [
  { level: 1, names: ["幼苗", "seedling", "Seedling"] },
  { level: 2, names: ["生長中", "budding", "Budding"] },
  { level: 3, names: ["常青", "evergreen", "Evergreen"] },
] as const;
/** Headings an article needs before 目錄 shows. */
export const TOC_MIN_HEADINGS = 2;

const v = (id: string, label: string): WidgetVariant => ({ id, label });

export const BUILTIN_WIDGETS: readonly WidgetDef[] = [
  { id: "nav", label: "導覽", blurb: "網站名稱、導覽連結與搜尋", classes: ["header"], variants: [v("bar", "靠左一列"), v("center", "置中"), v("minimal", "只有名稱與搜尋")] },
  {
    id: "intro", label: "自我介紹", blurb: "首頁筆記或「關於」筆記的第一段", classes: ["hero", "section"],
    variants: [v("paragraph", "第一段"), v("sentence", "第一句")],
    needs: "需要一篇首頁筆記或「關於」筆記", ready: (f) => f.introNote,
  },
  {
    id: "latest", label: "最新一篇", blurb: "最新發布的那一篇，附一句摘要", classes: ["hero", "section"],
    variants: [v("card", "標題與摘要"), v("link", "只有標題")],
    needs: "需要至少一篇已發布的文章", ready: (f) => f.articles > 0,
  },
  {
    id: "recent", label: "最近更新", blurb: "依更新時間排，最近 10 篇", classes: ["section"],
    variants: [v("list", "標題與更新日"), v("summary", "附一句話")],
    needs: "需要至少一篇已發布的文章", ready: (f) => f.articles > 0,
  },
  {
    id: "all", label: "全部文章", blurb: "所有已發布的文章", classes: ["section"],
    variants: [v("byYear", "依年份"), v("recent10", "最近 10 篇"), v("maturity", "標上成熟度")],
    needs: "需要至少一篇已發布的文章", ready: (f) => f.articles > 0,
  },
  {
    id: "topics", label: "主題", blurb: "標籤與各有幾篇", classes: ["section"],
    variants: [v("list", "清單"), v("chips", "一排標籤")],
    needs: "需要有標籤的已發布筆記", ready: (f) => f.topics > 0,
  },
  {
    id: "featured", label: "精選", blurb: "你標了「精選」的文章", classes: ["section"],
    variants: [v("list", "清單"), v("cards", "卡片")],
    needs: "需要標了「精選」的已發布筆記", ready: (f) => f.featured > 0,
  },
  { id: "subscribe", label: "訂閱", blurb: "RSS 訂閱的說明與連結", classes: ["hero", "section"], variants: [v("rss", "RSS")] },
  {
    id: "meta", label: "資訊行", blurb: "標題下的一行小字", classes: ["meta"],
    variants: [v("date-reading", "日期・閱讀時間"), v("date-tags", "日期・標籤"), v("all", "全部"), v("maturity-date", "成熟度・日期"), v("reading", "閱讀時間"), v("tags", "標籤"), v("reading-tags", "閱讀時間・標籤")],
  },
  {
    id: "toc", label: "目錄", blurb: "這篇的標題，兩個以上才出現；手機收成一塊放在最上面", classes: ["side"], variants: [v("list", "清單")],
    needs: `需要有 ${TOC_MIN_HEADINGS} 個以上標題的文章`, ready: (f) => f.headings >= TOC_MIN_HEADINGS,
  },
  {
    id: "sidenotes", label: "側註", blurb: "寬螢幕把註腳放在內文旁邊", classes: ["side"], variants: [v("margin", "放在旁邊")],
    needs: "需要有註腳的文章", ready: (f) => f.footnotes > 0, narrow: "hide",
  },
  {
    id: "tree", label: "檔案樹", blurb: "全部筆記依階層排開，資料夾可以收合；手機放在選單按鈕後面", classes: ["side"], variants: [v("tree", "階層")],
    needs: "需要有兩篇以上的已發布筆記", ready: (f) => f.articles > 1,
  },
  {
    id: "backlinks", label: "反向連結", blurb: "哪些筆記連到這一篇", classes: ["noteEnd"],
    variants: [v("quote", "附引用的那一句"), v("titles", "只有標題")],
    needs: "需要有其他已發布筆記連到的文章", ready: (f) => f.backlinks > 0,
  },
  {
    id: "graph", label: "關係圖", blurb: "這一篇與連到它、它連到的筆記畫成一張小圖，可以打開整個網站的圖", classes: ["noteEnd"],
    variants: [v("local", "小圖加全螢幕按鈕")],
    needs: "需要有其他已發布筆記連到、或這一篇連到其他已發布筆記", ready: (f) => f.linked > 0,
  },
  {
    id: "prevnext", label: "上一篇／下一篇", blurb: "文末的前後篇", classes: ["noteEnd"], variants: [v("links", "兩個連結")],
    needs: "需要有前後篇的文章", ready: (f) => f.hasPrev || f.hasNext,
  },
  {
    id: "tagdesc", label: "標籤說明", blurb: "標籤自己那篇筆記的內文", classes: ["tagDesc"], variants: [v("text", "文字")],
    needs: "需要標籤自己的筆記有內文，且已發布", ready: (f) => f.tagDescription,
  },
  { id: "tagnotes", label: "文章列表", blurb: "這個標籤下的已發布筆記", classes: ["tagList"], variants: [v("byYear", "依年份"), v("summary", "附一句話"), v("plain", "標題與日期"), v("view", "照標籤的檢視")] },
  { id: "tagfeed", label: "只訂閱這個標籤", blurb: "只有這個標籤的 RSS", classes: ["tagEnd"], variants: [v("rss", "RSS")] },
  { id: "copyright", label: "版權", blurb: "© 年份與網站名稱", classes: ["foot"], variants: [v("simple", "© 年份 名稱")] },
  { id: "rss", label: "RSS", blurb: "整個網站的 RSS 連結", classes: ["foot"], variants: [v("link", "連結")] },
  {
    id: "scheme", label: "讀者切換深淺", blurb: "讓讀者自己選淺色或深色", classes: ["foot"], variants: [v("toggle", "按鈕")],
    needs: "需要把配色設成「跟隨讀者的系統」", ready: (f) => f.scheme === "system",
  },
];

export type WidgetRegistry = {
  all: readonly WidgetDef[];
  get(id: string): WidgetDef | undefined;
  /** The widgets a box of this class takes, in registry order. */
  accepted(boxClass: BoxClass): WidgetDef[];
};

/** The built-in widgets plus those a feature module provides. A module widget with a built-in's id is ignored. */
export function createWidgetRegistry(extra: readonly WidgetDef[] = []): WidgetRegistry {
  const all = [...BUILTIN_WIDGETS, ...extra.filter((w) => !BUILTIN_WIDGETS.some((b) => b.id === w.id))];
  const byId = new Map(all.map((w) => [w.id, w]));
  return { all, get: (id) => byId.get(id), accepted: (boxClass) => all.filter((w) => w.classes.includes(boxClass)) };
}

export const WIDGETS: WidgetRegistry = createWidgetRegistry();

export const defaultVariantOf = (widget: WidgetDef): string => widget.variants[0]!.id;

/** Whether a widget has what it needs. `ready` absent = it always draws. */
export const widgetReady = (widget: WidgetDef, facts: WidgetFacts): boolean => widget.ready?.(facts) ?? true;
