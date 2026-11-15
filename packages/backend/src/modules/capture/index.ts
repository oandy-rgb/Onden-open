import type { ModuleDefinition, ModuleApp } from "../types.js";
import router from "./routes.js";

// Capture (捕捉) — a built-in module (docs/agents/decisions-modules.md): quick
// capture and its inbox page. Always available: no `library`, no switch, no
// write gate. A capture is an ordinary note (the frontend writes it through
// POST /api/nodes); what the module adds on the server is its tag.
//
// Its module tag is 收件匣: tag_schema.module = 'capture', made the first time a
// capture needs it (POST /api/capture/inbox, inboxTag.ts) the way the tasks
// module makes #task. The module has no `library`, so it does not use
// workspaceModules.ensureModuleTag (that is the library's, for the owner turning
// a module on); it is made by any member on first use (modules/capture/inboxTag).
//
// A capture with no place of its own is a top-level note with this tag and the
// reserved `_captured` flag (services/systemAttributes). Moving it under a note
// takes the tag off; the flag stays, so "what was jotted down that day" can
// still find it (frontend modules/capture/capturesOnDay).
export const captureModule: ModuleDefinition = {
  id: "capture",
  routePrefixes: ["/api/capture"],
  registerRoutes: (app: ModuleApp) => {
    app.route("/api/capture", router);
  },
};
