import type { ModuleDefinition, ModuleApp } from "../types.js";
import router from "./routes.js";
import { rssFetchEffect, startRssScheduler } from "./fetch.js";
import { hasSources } from "./sources.js";

// RSS module — onden's second plugin-shaped capability (after review).
//
//   • subscription source = a row of rss_subscriptions (migration 145), a
//     setting in a space, not a note (sources.ts);
//   • article = a row in rss_staging (the inbound boundary buffer) — NOT a
//     node, not an event, until the human saves it; the save route fires the
//     one NODE_CREATED, authored by the human ([[rss-rebuild]] revision:
//     subscription triage and agent-change approval are different queues);
//   • fetch loop = outbox `rss_fetch` intents (scheduler enqueues due
//     sources; the reconciler performs them) — no third rail; each pass also
//     runs the retention sweep (unseen ages to seen, seen ages to tombstone);
//   • NO agent tools: subscribing/refreshing stays a human act.

export const rssModule: ModuleDefinition = {
  id: "rss",
  routePrefixes: ["/api/rss"],
  registerRoutes: (app: ModuleApp) => {
    app.route("/api/rss", router);
  },
  startBackground: () => {
    startRssScheduler();
  },
  outboxEffects: [rssFetchEffect],
  personalTables: ["rss_mutes", "rss_seen"],
  // In use once the workspace has a subscription.
  // The server fetches outside websites: on only after the owner agrees once.
  library: { confirmOnce: true, inUse: hasSources },
};
