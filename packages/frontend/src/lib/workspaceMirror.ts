import type { Database } from "sql.js";
import type { Bootstrap, Workspace } from "./api";
import type { DbRun } from "./localDbPersist";

export type WorkspaceSettings = Pick<Bootstrap, "site_config" | "chrome">;

export function migrateWorkspaceMirror(db: Database): void {
  const columns = new Set(db.exec("PRAGMA table_info(workspace)")[0]?.values.map((row) => row[1]));
  for (const column of ["site_config", "chrome", "modules", "modules_to_confirm", "time_zone"]) {
    if (!columns.has(column)) db.run(`ALTER TABLE workspace ADD COLUMN ${column} TEXT`);
  }
  if (!columns.has("day_start_hour")) db.run("ALTER TABLE workspace ADD COLUMN day_start_hour INTEGER");
  if (!columns.has("actor_is_owner")) db.run("ALTER TABLE workspace ADD COLUMN actor_is_owner INTEGER");
  if (!columns.has("can_review")) db.run("ALTER TABLE workspace ADD COLUMN can_review INTEGER");
}

/** The settings columns (site_config, chrome) as the mirror stores them. */
function settingsColumns(settings: WorkspaceSettings): [string, string] {
  return [JSON.stringify(settings.site_config ?? {}), JSON.stringify(settings.chrome ?? null)];
}

export function upsertWorkspaceInto(db: DbRun, workspace: Workspace, settings: WorkspaceSettings): void {
  // Keep actor_role, actor_is_owner and can_review: domain edits must not alter the cached membership gate.
  db.run(
    `INSERT INTO workspace (id, name, slug, home_node_id, site_config, chrome, modules, modules_to_confirm, time_zone, day_start_hour) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, slug=excluded.slug,
       home_node_id=excluded.home_node_id, site_config=excluded.site_config, chrome=excluded.chrome,
       modules=excluded.modules, modules_to_confirm=excluded.modules_to_confirm,
       time_zone=excluded.time_zone, day_start_hour=excluded.day_start_hour`,
    [workspace.id, workspace.name, workspace.slug, workspace.home_node_id ?? null,
      ...settingsColumns(settings), writeWorkspaceModules(workspace.modules), writeWorkspaceModules(workspace.modules_to_confirm),
      workspace.time_zone ?? null, workspace.day_start_hour ?? 0],
  );
}

/** Store the site config and chrome a sync delta re-shipped (D119) on the
 *  mirrored workspace row, as upsertWorkspaceInto stores a bootstrap's. */
export function updateWorkspaceSettingsInto(db: DbRun, settings: WorkspaceSettings): void {
  db.run("UPDATE workspace SET site_config=?, chrome=?", settingsColumns(settings));
}

export function readWorkspaceSettings(row: { site_config: string | null; chrome: string | null }): WorkspaceSettings {
  return { site_config: JSON.parse(row.site_config ?? "{}"), chrome: JSON.parse(row.chrome ?? "null") };
}

/** workspace.modules as stored in the local mirror: a JSON array, or NULL for
 *  "every module" (a pre-library workspace or an older server). */
export function writeWorkspaceModules(modules: string[] | null | undefined): string | null {
  return Array.isArray(modules) ? JSON.stringify(modules) : null;
}

export function readWorkspaceModules(raw: unknown): string[] | null {
  if (typeof raw !== "string") return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
  } catch { return null; }
}
