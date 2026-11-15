import { describe, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import { createInitializationGate } from "../lib/initializationGate";
import { prepareLocalDatabase } from "../lib/localDbSchema";
import { upsertWorkspaceInto } from "../lib/workspaceMirror";
import { upsertEdgeInto } from "../lib/localMirror";

describe("local database readiness", () => {
  it("makes concurrent queue and bootstrap reads wait for a single database open", async () => {
    let finish!: () => void;
    const open = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const ready = createInitializationGate(open); const read = vi.fn();
    const a = ready().then(read); const b = ready().then(read);
    await Promise.resolve(); expect(open).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
    finish(); await Promise.all([a, b]); expect(read).toHaveBeenCalledTimes(2);
    await ready(); expect(open).toHaveBeenCalledOnce();
  });

  it("reports an initialization failure to all waiters and permits a later retry", async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error("Cannot open storage")).mockResolvedValueOnce(undefined);
    const ready = createInitializationGate(open);
    const results = await Promise.allSettled([ready(), ready()]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    await ready(); expect(open).toHaveBeenCalledTimes(2);
  });

  it("prepares an imported older vault using the same migrations as cold startup", async () => {
    const SQL = await initSqlJs(); const old = new SQL.Database();
    old.run("CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT, slug TEXT, home_node_id TEXT, actor_role TEXT)");
    old.run("INSERT INTO workspace VALUES ('w', 'Vault', 'vault', NULL, 'admin')");
    old.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, node_id TEXT, title TEXT, status TEXT)");
    old.run("INSERT INTO tasks VALUES ('t', 'n', 'Keep task', 'todo')");
    const imported = new SQL.Database(old.export()); prepareLocalDatabase(imported); prepareLocalDatabase(imported);
    upsertWorkspaceInto(imported, { id: "w", name: "Vault", slug: "vault", home_node_id: "n" }, { site_config: { brand: "Imported site" }, chrome: { blocks: [] } });
    expect(imported.exec("SELECT title, due_date, recur FROM tasks")[0]!.values).toEqual([["Keep task", null, null]]);
    expect(imported.exec("SELECT home_node_id, actor_role, site_config FROM workspace")[0]!.values).toEqual([["n", "admin", '{"brand":"Imported site"}']]);
    old.close(); imported.close();
  });

  it("gives an older edges table an origin column that edge rows keep (D74)", async () => {
    const SQL = await initSqlJs(); const db = new SQL.Database();
    db.run("CREATE TABLE edges (id TEXT PRIMARY KEY, source_node_id TEXT NOT NULL, target_node_id TEXT NOT NULL, edge_type TEXT NOT NULL, status TEXT NOT NULL)");
    db.run("INSERT INTO edges VALUES ('old', 'a', 'b', 'knowledge_link', 'active')");
    prepareLocalDatabase(db); prepareLocalDatabase(db);
    upsertEdgeInto(db, { id: "w", source_node_id: "a", target_node_id: "b", edge_type: "knowledge_link", status: "active", origin: "wikilink" });
    // A payload without origin (an older server) does not erase the stored one.
    upsertEdgeInto(db, { id: "w", source_node_id: "a", target_node_id: "b", edge_type: "knowledge_link", status: "active" });
    expect(db.exec("SELECT id, origin FROM edges ORDER BY id")[0]!.values).toEqual([["old", null], ["w", "wikilink"]]);
    db.close();
  });
});
