// The words of the site's boxes, widgets, looks and home page styles. @onden/site writes them in
// Chinese (they are the site's data, shared with the server); the app shows them through here, so an
// English interface does not print Chinese. English is the key and zh-TW the original, like every other
// app string; siteWords.test.ts walks the registries and fails for a word that has no entry here.
import { t, registerDictionary } from "../../../lib/i18n";
import { SITE_SETUP_ZH_TW } from "./strings.zh-TW";

/** [Chinese as @onden/site writes it, English]. */
const WORDS: ReadonlyArray<readonly [string, string]> = [
  // boxes
  ["頁首", "Header"], ["首頁開頭", "Top of the home page"], ["首頁區塊", "Home page sections"], ["標題下的資訊", "Info under the title"],
  ["內文左邊", "Left of the text"], ["內文右邊", "Right of the text"], ["文末", "End of the note"], ["標籤說明", "Tag description"],
  ["標籤的筆記", "Notes of the tag"], ["列表之後", "After the list"], ["頁尾", "Foot"],
  // widgets: name, what it is, what it needs
  ["導覽", "Navigation"], ["網站名稱、導覽連結與搜尋", "Site name, links and search"],
  ["自我介紹", "About me"], ["首頁筆記或「關於」筆記的第一段", "The first paragraph of the home note or the “About” note"],
  ["需要一篇首頁筆記或「關於」筆記", "Needs a home note or an “About” note"],
  ["最新一篇", "Latest note"], ["最新發布的那一篇，附一句摘要", "The newest published note, with a short summary"],
  ["需要至少一篇已發布的文章", "Needs at least one published article"],
  ["最近更新", "Recently updated"], ["依更新時間排，最近 10 篇", "Newest changes first, the last 10"],
  ["全部文章", "All articles"], ["所有已發布的文章", "Every published article"],
  ["主題", "Topics"], ["標籤與各有幾篇", "Tags and how many notes each has"], ["需要有標籤的已發布筆記", "Needs published notes that have tags"],
  ["精選", "Featured"], ["你標了「精選」的文章", "Articles you tagged “Featured”"], ["需要標了「精選」的已發布筆記", "Needs published notes tagged “Featured”"],
  ["訂閱", "Subscribe"], ["RSS 訂閱的說明與連結", "How to subscribe by RSS, with the link"],
  ["資訊行", "Info line"], ["標題下的一行小字", "A line of small text under the title"],
  ["目錄", "Contents"], ["這篇的標題，三個以上才出現", "This note's headings; shown with three or more"], ["需要有 3 個以上標題的文章", "Needs an article with 3 or more headings"],
  ["側註", "Side notes"], ["寬螢幕把註腳放在內文旁邊", "On a wide screen, footnotes sit beside the text"], ["需要有註腳的文章", "Needs an article with footnotes"],
  ["檔案樹", "Note tree"], ["全部筆記依階層排開", "All notes laid out by level"], ["需要有上下層的已發布筆記", "Needs published notes that sit inside each other"],
  ["反向連結", "Backlinks"], ["哪些筆記連到這一篇", "Which notes link to this one"], ["需要有其他已發布筆記連到的文章", "Needs an article that other published notes link to"],
  ["上一篇／下一篇", "Previous / next"], ["文末的前後篇", "The notes before and after, at the end"], ["需要有前後篇的文章", "Needs an article with a note before or after it"],
  ["標籤自己那篇筆記的內文", "The text of the tag's own note"], ["需要標籤自己的筆記有內文，且已發布", "Needs the tag's own note to have text and be published"],
  ["文章列表", "Article list"], ["這個標籤下的已發布筆記", "Published notes under this tag"],
  ["只訂閱這個標籤", "Subscribe to this tag only"], ["只有這個標籤的 RSS", "An RSS feed of this tag alone"],
  ["版權", "Copyright"], ["© 年份與網站名稱", "© year and site name"],
  ["整個網站的 RSS 連結", "A link to the whole site's RSS feed"],
  ["讀者切換深淺", "Light / dark switch"], ["讓讀者自己選淺色或深色", "Lets readers choose light or dark"], ["需要把配色設成「跟隨讀者的系統」", "Needs the colours set to “follow the reader's system”"],
  // looks
  ["靠左一列", "One row, left"], ["置中", "Centred"], ["只有名稱與搜尋", "Name and search only"],
  ["第一段", "First paragraph"], ["第一句", "First sentence"], ["卡片", "Card"],
  ["標題與摘要", "Title and summary"], ["只有標題", "Title only"], ["標題與更新日", "Title and update date"], ["附一句話", "With one sentence"],
  ["依年份", "By year"], ["最近 10 篇", "The last 10"], ["標上成熟度", "With growth stage"], ["清單", "Plain list"], ["一排標籤", "A row of tags"],
  ["日期・閱讀時間", "Date · reading time"], ["日期・標籤", "Date · tags"], ["全部", "All"], ["成熟度・日期", "Growth stage · date"],
  ["閱讀時間", "Reading time"], ["標籤", "Tags"], ["閱讀時間・標籤", "Reading time · tags"], ["放在旁邊", "Beside the text"], ["階層", "By level"],
  ["附引用的那一句", "With the sentence that links"], ["兩個連結", "Two links"], ["文字", "Text"], ["標題與日期", "Title and date"], ["照標籤的檢視", "As the tag's view"],
  ["© 年份 名稱", "© year name"], ["RSS", "RSS"], ["連結", "Link"], ["按鈕", "Button"],
];

/** Home page styles (HOME_PRESETS): their own table, because 「目錄」 is a style here and a widget above. */
const PRESET_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["簡單", "Simple"], ["自我介紹，下面是最近更新、主題與全部文章", "About me, then recent updates, topics and all articles"],
  ["花園", "Garden"], ["自我介紹，主題放前面，全部文章標上成熟度", "About me, topics first, every article with its growth stage"],
  ["電子報", "Newsletter"], ["訂閱在最前面，接著是最新一篇、精選與最近的文章", "Subscribe first, then the latest note, featured and recent articles"],
  ["目錄", "Index"], ["自我介紹，主題，最近 10 篇", "About me, topics, the last 10 articles"],
];

const table = (pairs: ReadonlyArray<readonly [string, string]>) => new Map(pairs);
const SITE = table(WORDS);
const PRESETS = table(PRESET_WORDS);

// The app's zh-TW dictionary at its source: English → the Chinese above. Registered with this part, so it costs no boot JS.
registerDictionary("zh-TW", SITE_SETUP_ZH_TW);
registerDictionary("zh-TW", Object.fromEntries([...WORDS, ...PRESET_WORDS].map(([zh, en]) => [en, zh])));

const say = (words: Map<string, string>, zh: string): string => {
  const en = words.get(zh);
  return en === undefined ? zh : t(en); // a module's own widget brings its own words
};

/** A box, widget, look or need as written in @onden/site, in the app's language. */
export const siteWord = (zh: string): string => say(SITE, zh);
/** A home page style's name or description, in the app's language. */
export const presetWord = (zh: string): string => say(PRESETS, zh);

/** Every Chinese word this file knows, for the test that walks the registries. */
export const KNOWN_SITE_WORDS = { site: new Set(SITE.keys()), presets: new Set(PRESETS.keys()) };
