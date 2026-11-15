// RSS module (frontend) — the reader and subscriptions. Everything the shell
// shows for RSS is declared here and read through modules/index.ts:
//   • readingSections — the reading hub (閱讀) is the two-pane reader
//     (`?view=rss`), lazy so the markdown renderer chunk stays out of the
//     main bundle;
//   • NavIndicator — a dot on 閱讀 (and RSS in 更多) when articles arrived
//     since the reader was last open; numbers only with 「顯示未讀數字」. New articles live here, not
//     in the inbox: the inbox holds only what waits for someone's approval;
//   • HomeSection — "new articles to skim" (nothing when none);
//   • openCommand — the "Go to Reading" palette action;
//   • settings — 「顯示未讀數字」, the OPML import widget and 「預設存到」 (where a saved
//     article goes when its feed has no default), under 「設定」 on the
//     module's card (Settings › Modules › RSS).

import { lazyWithReload } from "../../lib/lazyWithReload";
import { Rss } from "lucide-react";
import type { FrontendModule } from "../types";
import RssHomeSection from "./RssHomeSection";
import RssNavIndicator from "./RssNavIndicator";
import { SHOW_COUNTS_SETTING } from "./rssCounts";

// Settings widgets and the screen load on demand: only the registration stays in the boot chunk.
const RssOpmlWidget = lazyWithReload(() => import("./RssOpmlWidget"));
const RssDefaultsWidget = lazyWithReload(() => import("./RssDefaultsWidget"));
const RssSourceSpaceWidget = lazyWithReload(() => import("./RssSourceSpaceWidget"));
const ReadingPreview = lazyWithReload(() => import("./ReadingPreview"));

// An excerpt with its source link, or a line, written into a note (rssQuote.ts); loaded on use.
export const loadRssQuote = () => import("./rssQuote");

export { useRssUnread, primeRssSources, useRssSourceCount, type RssSource } from "./useRssUnread";

export const rssModule: FrontendModule = {
  id: "rss",
  generatedSourceTypes: ["rss"],
  library: {
    // A visible subscription. Subscriptions are a table, not notes (migration
    // 145), so the count comes from the reader's shared feed list (useRssSourceCount).
    inUse: ({ subscriptions }) => (subscriptions ?? 0) > 0,
    title: "Reading",
    confirm: "RSS makes the server visit the websites you subscribe to, on a schedule, to fetch new articles.",
    description: "Subscribe to sites and blogs, read new articles, and save the ones worth keeping as notes. Asks once before it starts.",
    Icon: Rss,
    group: { id: "reading", order: 1 },
    blurb: "Follow sites and read new articles",
    manifest: {
      adds: [
        { kind: "page", text: "The Reading page: your feeds and their new articles." },
        { kind: "schedule", text: "Checks each feed for new articles, every 60 minutes by default." },
        { kind: "import", text: "OPML import and export of your subscriptions." },
      ],
      notes: "Makes a note for each article you save; saves quotes into the notes you pick.",
      network: "Fetches the feeds you subscribe to, and an article's page when you load its full text.",
    },
  },
  readingSections: [
    { id: "rss", label: "RSS", Icon: Rss, order: 10, Component: lazyWithReload(() => import("./RssScreen")), Badge: RssNavIndicator },
  ],
  NavIndicator: RssNavIndicator,
  openCommand: { id: "a-rss", label: "Go to Reading", keywords: ["rss", "feed", "subscriptions", "read", "news", "reader", "閱讀", "訂閱", "新聞", "文章"], group: "Navigate", hint: "place" },
  HomeSection: ({ open }) => <RssHomeSection onOpenReader={() => open()} />,
  SettingsPreview: ReadingPreview,
  settings: [SHOW_COUNTS_SETTING, {
    id: "modules.rss_save_default",
    tab: "modules",
    label: "Default save destination",
    keywords: ["save", "folder", "tag", "parent", "存到", "預設", "資料夾"],
    type: "custom",
    component: RssDefaultsWidget,
  }, {
    id: "modules.rss_source_space",
    tab: "modules",
    label: "Keep subscriptions in",
    keywords: ["subscriptions", "space", "share", "shared", "訂閱", "空間", "共用", "放在"],
    type: "custom",
    component: RssSourceSpaceWidget,
  }, {
    id: "data.import_rss_opml",
    tab: "data",
    section: "Import",
    label: "RSS subscriptions (OPML)",
    type: "custom",
    component: RssOpmlWidget,
  }],
};
