// The space permission list lives once, in spine/spaceAccess.ts. These checks
// pin its values, the schema's CHECK list, and that no other backend file spells
// the old member-role ladder out again.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SPACE_PERMISSIONS, isSpacePermission } from "../spine/spaceAccess.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const DB_DIR = join(SRC, "..", "db");

describe("space permissions", () => {
  it("are view and edit", () => {
    expect([...SPACE_PERMISSIONS]).toEqual(["view", "edit"]);
  });

  it("put no value and unknown strings outside the list (fail closed)", () => {
    for (const value of [null, undefined, "", "viewer", "editor", "manager", "admin", "owner", "constructor", "toString"]) {
      expect(isSpacePermission(value)).toBe(false);
    }
    expect(isSpacePermission("view")).toBe(true);
    expect(isSpacePermission("edit")).toBe(true);
  });

  it("match the space_members CHECK constraint added by migration 127", () => {
    const migration = readFileSync(join(DB_DIR, "migrations", "127_owner_member.sql"), "utf8");
    const check = /space_members_permission_check CHECK \(permission IN \(([^)]*)\)\)/.exec(migration);
    expect(check).not.toBeNull();
    expect(check![1]!.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([...SPACE_PERMISSIONS]);
  });

  it("the old member-role ladder is not spelled out anywhere in the backend", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== "test") walk(path); continue; }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
        const text = readFileSync(path, "utf8");
        if (/'editor',\s*'manager'|"viewer",\s*"editor",\s*"manager"|viewer:\s*0,\s*editor:\s*1|WRITE_ROLES_SQL|SPACE_ROLES/.test(text)) offenders.push(relative(SRC, path));
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
