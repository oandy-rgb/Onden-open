// Read-policy chokepoint guard — the by-construction backstop for gap #1.
//
// The public-site leak (a published child under a read:admin parent, or a
// published collection item under a restricted tag) was caused by the PUBLISH
// path REIMPLEMENTING the read rule with its own per-node SQL fragment
// (READ_RESTRICTED_EXCLUSION_SQL) that did NOT cascade ancestors. The canonical
// rule — ancestor-cascading, most-restrictive-wins — lives in
// services/readPolicy.ts (visibleNodeIdsForActor's recursive CTE), and every
// public surface now DERIVES from it via publiclyReadableNodeIds. There is no
// eslint here, so this test IS the gate: it greps the backend source and fails
// if any OTHER file inlines the read-rank SQL fragment. A divergent
// reimplementation (the exact shape of the bug) then breaks CI structurally,
// so a new publish path can't quietly bypass the chokepoint again.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// The read-rank SQL fragment: extracting a tag policy's READ operation rank
// inside SQL is the exact thing a publish path must NOT do (it has to call the
// shared readPolicy primitive instead). Matching the JSONB-path form catches
// both the old exclusion SQL and any new copy.
const READ_RANK_SQL = /policy->'operations'->>'read'/;

// The legacy identifier — must be fully gone from live code (no re-export, no
// re-introduction). Comments referencing it historically are fine.
const LEGACY_IDENTIFIER = /\bexport\s+const\s+READ_RESTRICTED_EXCLUSION_SQL\b|READ_RESTRICTED_EXCLUSION_SQL\s*[,}]/;

// The ONLY files allowed to contain the read-rank SQL fragment: the canonical
// read policy and the spine's write-side permission check (its sibling).
const ALLOWED = new Set([
  join("services", "readPolicy.ts"),
  join("services", "dispatcher", "permissions.ts"),
]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("read-policy chokepoint — the read rule lives in ONE place", () => {
  const files = tsFiles(srcDir);

  it("the read-rank SQL fragment appears ONLY in readPolicy.ts / permissions.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(srcDir, file);
      // Skip the test tree — these guards reference the fragment in strings.
      if (rel.split(sep)[0] === "test") continue;
      const src = readFileSync(file, "utf8");
      if (READ_RANK_SQL.test(src) && !ALLOWED.has(rel)) offenders.push(rel);
    }
    expect(
      offenders,
      "these files inline the read-rank SQL instead of calling the shared " +
        "readPolicy primitive (publiclyReadableNodeIds / visibleNodeIdsForActor) — " +
        "a divergent copy is how the public-site leak (gap #1) happened",
    ).toEqual([]);
  });

  it("READ_RESTRICTED_EXCLUSION_SQL is gone from live code", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(srcDir, file);
      if (rel.split(sep)[0] === "test") continue;
      const src = readFileSync(file, "utf8");
      // Strip line comments so historical mentions in prose don't trip the gate.
      const code = src.replace(/\/\/.*$/gm, "");
      if (LEGACY_IDENTIFIER.test(code)) offenders.push(rel);
    }
    expect(
      offenders,
      "READ_RESTRICTED_EXCLUSION_SQL must not be defined/imported in live code",
    ).toEqual([]);
  });
});
