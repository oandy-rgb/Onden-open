// External calendars (frontend): read-only subscriptions to calendars kept elsewhere
// (a calendar's iCal link), shown on the day timeline and the week board.
//
// Registration only. The settings list is loaded when its page opens; the pieces on
// the timeline (modules/daily/day/external) are loaded with the day pane. The shell
// asks the feature "ext-calendars" (lib/shellFeatures), never this module by id, so
// switching the module off removes the settings, the events on the timeline and the requests.

import { Link2 } from "lucide-react";
import type { FrontendModule } from "../types";
import { lazyWithReload } from "../../lib/lazyWithReload";

const CalendarsSetting = lazyWithReload(() => import("./CalendarsSetting"));

export const externalCalendarsModule: FrontendModule = {
  id: "external_calendars",
  shellFeature: "ext-calendars",
  library: {
    title: "External calendars",
    // Description and manifest are shown only by the first-use confirmation (library.confirm), which this module does not
    // have: nothing is fetched until a person pastes a link, so there is no yes to ask for.
    description: "iCal calendars.",
    Icon: Link2,
    requiresAny: ["daily", "tasks"],
    group: { id: "time", order: 3 },
    blurb: "Show events from elsewhere in the journal and tasks",
    manifest: { adds: [], notes: "", network: null },
  },
  settings: [{
    id: "modules.calendars",
    tab: "modules",
    label: "",
    keywords: ["ical"],
    type: "custom",
    component: CalendarsSetting,
  }],
};
