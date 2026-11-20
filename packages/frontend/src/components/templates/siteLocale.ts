// Published-site chrome locale (Quartz-style `locale` config): one dictionary
// for the few strings the site CHROME renders (note CONTENT is whatever the
// author wrote — this never translates content). Components resolve via
// makeT(site.locale); unknown locales fall back to English per key.

import type { SiteLocale } from "@onden/markdown";

type SiteStringKey =
  | "allNotes" | "backHome" | "backlinks" | "closePreview" | "embedsPage" | "embedsPassage" | "feed" | "navigation" | "next"
  | "noResults" | "onThisPage" | "openNote" | "pageNotFound" | "preview" | "previous" | "readingTime" | "search" | "updated"
  | "topics" | "recentlyUpdated" | "allArticles" | "latestArticle" | "featured" | "subscribe" | "subscribeLead" | "tagFeed" | "theme"
  | "handwritingPage" | "notesCount" | "maturity1" | "maturity2" | "maturity3" | "footnotes" | "footnoteBack" | "sideNotes" | "articlesInTag"
  | "stepPrev" | "stepNext" | "stepsAll" | "stepsOne" | "stepCount" | "siteUnavailable" | "siteUnavailableLead"
  | "searchOpen" | "searchClose" | "searchBuilding" | "searchMore" | "breadcrumb" | "childNotes" | "noText" | "showAllNotes";

const EN: Record<SiteStringKey, string> = {
  search: "Search…",
  noResults: "No results for",
  onThisPage: "On this page",
  previous: "← Previous",
  next: "Next →",
  navigation: "Navigation",
  pageNotFound: "Page not found",
  backHome: "Back to the home page",
  backlinks: "Linked from",
  allNotes: "All notes",
  feed: "RSS",
  closePreview: "Close",
  embedsPage: "Embeds this page",
  embedsPassage: "Embeds a passage of this page: “{text}”",
  openNote: "Open this page",
  preview: "Preview",
  readingTime: "{n} min read",
  handwritingPage: "Handwriting, page {n}",
  updated: "Updated {date}",
  topics: "Topics",
  recentlyUpdated: "Recently updated",
  allArticles: "All articles",
  latestArticle: "Latest",
  featured: "Featured",
  subscribe: "Subscribe",
  subscribeLead: "Follow new writing with any RSS reader.",
  tagFeed: "Follow only this tag",
  theme: "Light / dark",
  notesCount: "{n} notes",
  maturity1: "Seedling",
  maturity2: "Growing",
  maturity3: "Evergreen",
  footnotes: "Footnotes",
  footnoteBack: "Back to reference {n}",
  sideNotes: "Notes",
  articlesInTag: "Notes",
  stepPrev: "Previous step",
  stepNext: "Next step",
  stepsAll: "Show all",
  stepsOne: "One at a time",
  stepCount: "Step {n} of {m}",
  siteUnavailable: "Site unavailable",
  siteUnavailableLead: "The site can't be shown right now. Please try again in a moment.",
  searchOpen: "Search",
  searchClose: "Close search",
  searchBuilding: "Search isn't ready yet. Please try again in a moment.",
  searchMore: "Try two or more characters.",
  breadcrumb: "Where this page is",
  childNotes: "In this note",
  noText: "This page has no text.",
  showAllNotes: "Show all {n} notes",
};

const STRINGS: Record<SiteLocale, Record<SiteStringKey, string>> = {
  en: EN,
  "zh-TW": {
    search: "搜尋…",
    noResults: "找不到",
    onThisPage: "本頁目錄",
    previous: "← 上一篇",
    next: "下一篇 →",
    navigation: "導覽",
    pageNotFound: "找不到這一頁",
    backHome: "回到首頁",
    backlinks: "這些筆記連到這裡",
    allNotes: "所有筆記",
    feed: "RSS 訂閱",
    closePreview: "關閉",
    embedsPage: "內嵌了這篇",
    embedsPassage: "內嵌了這篇的一段：『{text}』",
    openNote: "打開這篇",
    preview: "預覽",
    readingTime: "約 {n} 分鐘讀完",
    handwritingPage: "手寫第 {n} 頁",
    updated: "更新於 {date}",
    topics: "主題",
    recentlyUpdated: "最近更新",
    allArticles: "全部文章",
    latestArticle: "最新一篇",
    featured: "精選",
    subscribe: "訂閱",
    subscribeLead: "用任何 RSS 閱讀器追蹤新文章。",
    tagFeed: "只訂閱這個標籤",
    theme: "切換淺色／深色",
    notesCount: "{n} 篇",
    maturity1: "幼苗",
    maturity2: "生長中",
    maturity3: "常青",
    footnotes: "註腳",
    footnoteBack: "回到內文第 {n} 處",
    sideNotes: "註",
    articlesInTag: "筆記",
    stepPrev: "上一步",
    stepNext: "下一步",
    stepsAll: "全部展開",
    stepsOne: "一次一步",
    stepCount: "第 {n} 步／共 {m} 步",
    siteUnavailable: "網站暫時無法顯示",
    siteUnavailableLead: "目前讀不到網站內容，請稍後再試。",
    searchOpen: "搜尋",
    searchClose: "關閉搜尋",
    searchBuilding: "搜尋還沒準備好，請稍後再試。",
    searchMore: "再多打一個字試試。",
    breadcrumb: "這一頁的位置",
    childNotes: "這篇底下的筆記",
    noText: "這一頁沒有文字內容。",
    showAllNotes: "顯示全部 {n} 篇",
  },
  ja: {
    search: "検索…",
    noResults: "見つかりません:",
    onThisPage: "目次",
    previous: "← 前へ",
    next: "次へ →",
    navigation: "ナビゲーション",
    pageNotFound: "ページが見つかりません",
    backHome: "ホームに戻る",
    backlinks: "このページへのリンク",
    allNotes: "すべてのノート",
    feed: "RSS",
    closePreview: "閉じる",
    embedsPage: "このページを埋め込んでいます",
    embedsPassage: "このページの一部を埋め込んでいます：「{text}」",
    openNote: "このページを開く",
    preview: "プレビュー",
    readingTime: "約{n}分で読めます",
    handwritingPage: "手書き {n} ページ目",
    updated: "更新 {date}",
    topics: "トピック",
    recentlyUpdated: "最近の更新",
    allArticles: "すべての記事",
    latestArticle: "最新の記事",
    featured: "注目",
    subscribe: "購読",
    subscribeLead: "RSS リーダーで新しい記事を追えます。",
    tagFeed: "このタグだけ購読",
    theme: "ライト／ダーク",
    notesCount: "{n} 件",
    maturity1: "芽",
    maturity2: "成長中",
    maturity3: "常緑",
    footnotes: "脚注",
    footnoteBack: "本文の {n} 番へ戻る",
    sideNotes: "注",
    articlesInTag: "ノート",
    stepPrev: "前のステップ",
    stepNext: "次のステップ",
    stepsAll: "すべて表示",
    stepsOne: "1 つずつ",
    stepCount: "{m} 中 {n} ステップ目",
    siteUnavailable: "サイトを表示できません",
    siteUnavailableLead: "現在サイトを読み込めません。しばらくしてからもう一度お試しください。",
    searchOpen: "検索",
    searchClose: "検索を閉じる",
    searchBuilding: "検索の準備ができていません。しばらくしてからもう一度お試しください。",
    searchMore: "2 文字以上で試してください。",
    breadcrumb: "このページの場所",
    childNotes: "このノートの下",
    noText: "このページには本文がありません。",
    showAllNotes: "{n} 件すべてを表示",
  },
};

/** A `YYYY-MM-DD` day as the site's language writes a date: 2026年11月20日 in Chinese and Japanese, the ISO form
 *  elsewhere. `monthDay` leaves the year off (the group heading above a list has it). */
export function formatSiteDay(day: string, locale?: string, monthDay = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const [, y, mo, d] = m;
  if ((locale ?? DEFAULT_SITE_LOCALE) === "en") return monthDay ? `${mo}-${d}` : day;
  return `${monthDay ? "" : `${y}年`}${Number(mo)}月${Number(d)}日`;
}

const DEFAULT_SITE_LOCALE: SiteLocale = "zh-TW";

export function makeT(locale?: string): (key: SiteStringKey) => string {
  const dict = STRINGS[(locale as SiteLocale) ?? DEFAULT_SITE_LOCALE] ?? STRINGS[DEFAULT_SITE_LOCALE];
  return (key) => dict[key] ?? EN[key];
}
