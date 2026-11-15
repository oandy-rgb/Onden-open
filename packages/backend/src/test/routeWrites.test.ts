// Route writes — the vitest backstop for eslint onden/no-route-writes (depth
// audit D2), sharing its source of truth like readGuard.test.ts does: no
// route file (routes/**, modules/*/routes.ts) holds an SQL write statement;
// the service that owns the row writes it. The allowlist is empty.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { ALLOWLIST, isRouteFile, sqlWriteIn } from "../../eslint-rules/no-route-writes.js";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []);
}

describe("routes don't write SQL", () => {
  const routeFiles = files(srcDir)
    .map((path) => ({ path, rel: relative(srcDir, path).split(sep).join("/") }))
    .filter(({ rel }) => isRouteFile(rel));

  it("finds the route files", () => {
    expect(routeFiles.map((f) => f.rel)).toEqual(expect.arrayContaining(["routes/nodes.ts", "modules/rss/routes.ts"]));
  });

  it("the allowlist is empty", () => {
    expect(ALLOWLIST).toEqual({});
  });

  it("no route file holds an INSERT / UPDATE … SET / DELETE / TRUNCATE / MERGE", () => {
    const offenders = routeFiles.flatMap(({ path, rel }) => {
      // Comments may name a statement; only code counts (the lint reads literals).
      const code = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const statement = sqlWriteIn(code);
      return statement ? [`${rel}: ${statement}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("recognises the shapes it guards", () => {
    for (const sql of [
      "INSERT INTO node_edges (id) VALUES ($1)",
      "update content_nodes set title = $2",
      "UPDATE content_nodes n SET hidden = false",
      "UPDATE rss_staging SET seen_at = x WHERE id = ANY($1)",
      "DELETE FROM node_positions WHERE surface = $2",
      "TRUNCATE rss_seen",
    ]) expect(sqlWriteIn(sql), sql).not.toBeNull();
    for (const sql of ["SELECT updated_at FROM content_nodes", "ON CONFLICT DO NOTHING", "the note was deleted from the set"]) {
      expect(sqlWriteIn(sql), sql).toBeNull();
    }
  });
});
