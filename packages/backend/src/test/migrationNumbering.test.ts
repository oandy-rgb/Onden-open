// Guards against the 064-style collision: two migrations sharing a numeric
// prefix. The runner (db.ts) sorts by FULL filename and keys schema_migrations on
// the full version string, so the EXISTING 064 pair is harmless (deterministic
// order, distinct rows). But a NEW duplicate is a foot-gun for any tooling that
// reasons about the numeric sequence — and a tell that someone branched off a
// stale migration count. The 064 pair is a documented historical exception;
// never add another. (No DB needed — pure directory check, runs in the unit lane.)

import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Historical: 064_content_nodes_slug_unique + 064_idempotency_keys coexist.
const KNOWN_DUPLICATE_PREFIXES = new Set(["064"]);

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f));
}

describe("migration numbering", () => {
  it("has no duplicate numeric prefixes (except the documented historical 064 pair)", () => {
    const byPrefix = new Map<string, string[]>();
    for (const f of migrationFiles()) {
      const prefix = f.match(/^(\d+)_/)![1];
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), f]);
    }
    const offending = [...byPrefix.entries()]
      .filter(([prefix, files]) => files.length > 1 && !KNOWN_DUPLICATE_PREFIXES.has(prefix))
      .map(([prefix, files]) => `${prefix}: ${files.join(", ")}`);
    expect(
      offending,
      "duplicate migration number prefixes — branched off a stale count? renumber the new one to the next free number",
    ).toEqual([]);
  });

  it("the known 064 exception still exists (prune the allowlist once it's renumbered away)", () => {
    // Allowlist hygiene: if the 064 pair is ever resolved to ≤1 file, this fails
    // so the "064" entry gets removed from KNOWN_DUPLICATE_PREFIXES (a stale
    // exception is itself a foot-gun).
    expect(migrationFiles().filter((f) => /^064_/.test(f)).length).toBe(2);
  });
});
