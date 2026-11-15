// Website module (frontend) — the published site. Everything the shell shows
// for it is declared here and read through modules/index.ts:
//   • screen — the site studio (`?view=website`): the home-page design and
//     publishing; listed under More → Organize and publish, and offered
//     from a canvas card's menu to open that note's page;
//   • openCommand — the "Go to Website" palette action;
//   • noteFunctionRow — the note's publish status and actions, a row of the
//     info panel's 「功能」 section;
//   • settings — Settings › Website: language, description, search engines,
//     visitor statistics and custom domain (SiteBasicsSettings);
//   • sitePublisher — the welcome card's "Build your first website"
//     (introSite.ts).
// The public site pages (src/pages/site, components/siteFrame) stay outside:
// they serve readers, not the studio.

import { lazyWithReload } from "../../lib/lazyWithReload";
import { Globe } from "lucide-react";
import type { FrontendModule } from "../types";
import { PUBLISHED_ATTR, siteStanding } from "./publishBlocker";
import { loadedSpaces } from "../../lib/spaces";
import { t } from "../../lib/i18n";
import { hasChildNote } from "../../lib/appStore";
import { isNote } from "@onden/markdown/contract";

// The site row of the info panel, the snapshots list and the settings load when shown; only the registration is in the boot chunk.
const SiteBasicsSettings = lazyWithReload(() => import("./SiteBasicsSettings"));

export const websiteModule: FrontendModule = {
  id: "website",
  library: {
    // A note is marked for publishing.
    inUse: ({ nodes }) => nodes.some((n) => n.attrs?.[PUBLISHED_ATTR] === "true"),
    title: "Website",
    confirm: "The website publishes the notes in the spaces you choose to the public web, where anyone with the link can read them.",
    description: "Publish the notes of chosen spaces as a website, with pages, layout and design. Asks once before it starts.",
    Icon: Globe,
    group: { id: "publish", order: 2 },
    blurb: "Publish a space's notes as a website",
    manifest: {
      adds: [
        { kind: "page", text: "The Website page: pages, layout and design." },
        { kind: "command", text: "Publish a note from the note menu." },
      ],
      notes: "Only the notes in spaces you turn publishing on for; nothing is published by itself.",
      network: "Publishes the notes in the spaces you choose to the public web, where anyone with the link can read them.",
    },
  },
  screen: {
    label: "Site", Icon: Globe, Component: lazyWithReload(() => import("./WebsiteScreen")),
  },
  openCommand: { id: "a-website", label: "Go to Website", keywords: ["publish", "site", "blog", "website", "網站", "發布", "部落格", "分享"], group: "Navigate", hint: "place" },
  // A note in a space that publishes is on the site; the command below brings
  // one the site keeps off back on (its own 「不發布」, blank, a saved article),
  // and PublishNoteRow says where the note stands and keeps it off.
  noteFunctionRows: () => import("./noteFunctionRows"),
  noteCommands: [{
    id: "a-publish-note",
    label: "Publish to the site",
    keywords: ["publish", "site", "website", "網站", "發布"],
    row: {
      Icon: Globe, action: "Publish",
      describe: () => t("Put this note on your public site"),
      related: () => false,
      hint: "Put this note on your public site",
    },
    available: (node) => {
      const standing = siteStanding(node, loadedSpaces(), hasChildNote(node.id));
      return isNote(node) && !standing.on && standing.reason !== "hidden" && standing.reason !== "space";
    },
    run: ({ node }) => import("./putOnSite").then((m) => m.putOnSite(node)),
  }],
  settings: [{
    id: "website.basics",
    tab: "modules",
    label: "Website",
    keywords: ["language", "description", "search", "seo", "analytics", "domain", "語言", "描述", "搜尋", "統計", "網域"],
    type: "custom",
    component: SiteBasicsSettings,
  }],
  // Loaded on the click: the welcome card is the only caller.
  sitePublisher: { buildIntroSite: () => import("./introSite").then((m) => m.buildIntroSite()) },
};
