import type { ModuleDefinition } from "../types.js";
import router from "./routes.js";
import { startCalendarScheduler } from "./refresh.js";

// External calendars: read-only iCal subscriptions, shown on the day timeline.
//
//   • a calendar is a row of external_calendars (migration 160), a personal
//     setting, not a note; its address is kept sealed (store.ts, services/serverSecret.ts);
//   • its events are rows of external_calendar_events, replaced whole on each fetch.
//     They are never notes: not in the tree, search, sync of notes, or the website;
//   • the fetch loop is a periodic job (refresh.ts, 15 minutes, first pass at boot),
//     through the one outbound gate (services/safeFetch);
//   • NO agent tools: subscribing is a human act.
// Switched off, the routes refuse writes (library gate), the job fetches nothing for
// the workspace, and the timeline asks for nothing; the rows stay until deleted.

export const externalCalendarsModule: ModuleDefinition = {
  id: "external_calendars",
  routePrefixes: ["/api/external-calendars"],
  registerRoutes: (app) => {
    app.route("/api/external-calendars", router);
  },
  startBackground: () => {
    startCalendarScheduler();
  },
  personalTables: ["external_calendars"],
  // No first-use confirmation (unlike RSS): nothing is fetched until a person pastes a link, which is
  // the consent; the module can be switched off at any time.
  library: {},
};
