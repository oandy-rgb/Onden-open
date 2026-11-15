import type { ModuleDefinition } from "../types.js";
import dayRouter from "../../routes/day.js";
import { q } from "../../db.js";
import { liveNodeSql } from "../../spine/nodeSql.js";

// Daily notes (日記): today's note — the Today button, quick capture's and the
// agenda's fallback note, the home mood picker, the "Daily note" template —
// and the day lens a day note shows (GET /api/day/:date/lens). Always-on day
// notes got in the way, so this is a library module: OFF for a new workspace,
// ON for every workspace that already had a list (migration 112) and for a
// pre-library workspace that has day notes (inUse below). Removing it hides
// every entry point and keeps the day notes — they stay ordinary notes.
//
// The frontend owns creating day notes (lib/data/dayNotes.ts openToday refuses
// while the module is not imported); the server has no day-note writes. The
// lens route is read-only, so the module gate (writes only) never closes it:
// reads keep serving, as for every removed module.
export const dailyModule: ModuleDefinition = {
  id: "daily",
  routePrefixes: ["/api/day"],
  registerRoutes: (app) => {
    app.route("/api/day", dayRouter);
  },
  library: { inUse: hasDayNotes },
};

/** Whether the workspace already has a day note: a live note titled (or
 *  slugged) with an ISO date — the frontend's dayNodeDate convention. */
export async function hasDayNotes(workspaceId: string): Promise<boolean> {
  const r = await q<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM content_nodes
        WHERE workspace_id = $1 AND ${liveNodeSql()} AND hidden = false
          AND node_type = 'content'
          AND (title ~ '^\\d{4}-\\d{2}-\\d{2}$' OR slug ~ '^\\d{4}-\\d{2}-\\d{2}$')
     ) AS found`, [workspaceId],
  );
  return r.rows[0]?.found === true;
}
