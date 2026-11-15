import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { migrateWorkspaceMirror, readWorkspaceSettings, upsertWorkspaceInto } from "../lib/workspaceMirror";

describe("workspace mirror", () => {
  it("upgrades an existing database and cold-opens settings and an empty layout without changing membership", async () => {
    const SQL = await initSqlJs(); const db = new SQL.Database();
    db.run("CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT, slug TEXT, home_node_id TEXT, actor_role TEXT)");
    db.run("INSERT INTO workspace VALUES ('w', 'Workspace', 'workspace', NULL, 'editor')");
    migrateWorkspaceMirror(db); migrateWorkspaceMirror(db);
    const workspace = { id: "w", name: "Workspace", slug: "workspace", home_node_id: "page" };
    upsertWorkspaceInto(db, workspace, { site_config: { brand: "離線品牌", darkMode: true, nav: [{ label: "Home", nodeId: "page" }] }, chrome: { blocks: [] } });
    const reopened = new SQL.Database(db.export());
    const rows = reopened.exec("SELECT home_node_id, actor_role, site_config, chrome FROM workspace")[0]!.values;
    expect(rows[0]!.slice(0, 2)).toEqual(["page", "editor"]);
    const settings = readWorkspaceSettings({ site_config: rows[0]![2] as string, chrome: rows[0]![3] as string });
    expect(settings).toMatchObject({ site_config: { brand: "離線品牌", darkMode: true }, chrome: { blocks: [] } });
    upsertWorkspaceInto(reopened, { ...workspace, home_node_id: null }, settings);
    expect(reopened.exec("SELECT home_node_id, actor_role FROM workspace")[0]!.values).toEqual([[null, "editor"]]);
    db.close(); reopened.close();
  });

  it("keeps whether the caller is the workspace owner for an offline start; an older mirror reads as not the owner", async () => {
    const SQL = await initSqlJs(); const db = new SQL.Database();
    db.run("CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT, slug TEXT, home_node_id TEXT, actor_role TEXT)");
    db.run("INSERT INTO workspace VALUES ('w', 'Workspace', 'workspace', NULL, 'admin')");
    migrateWorkspaceMirror(db);
    expect(db.exec("SELECT actor_is_owner FROM workspace")[0]!.values).toEqual([[null]]);
    db.run("UPDATE workspace SET actor_is_owner = 1");
    upsertWorkspaceInto(db, { id: "w", name: "Renamed", slug: "workspace", home_node_id: null }, { site_config: {}, chrome: null });
    expect(db.exec("SELECT name, actor_is_owner FROM workspace")[0]!.values).toEqual([["Renamed", 1]]);
    db.close();
  });
});
