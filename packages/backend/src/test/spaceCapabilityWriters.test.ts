// A space's switches (publish, external_ai, backup, shared_seen) decide who
// reads its notes: the published site, agent tokens, the backup. The space
// service (services/spaces.ts) is their one writer: it records SPACE_UPDATED
// with the previous values and tells the space-audience hook, so the website
// takes pages off the static host at once. A raw `UPDATE spaces SET
// capabilities` elsewhere skipped both (D118: removing a member left their
// published notes on the host). This scan fails on any such write outside
// spaces.ts.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..");
const OWNER = "services/spaces.ts";

/** `UPDATE spaces [alias] SET …capabilities…` within one statement. */
const WRITES = /UPDATE\s+spaces\b(?:\s+(?:AS\s+)?\w+)?\s+SET\b[^`;]*\bcapabilities\b/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("a space's switches change only through the space service", () => {
  it("the pattern catches the write it guards against", () => {
    expect(WRITES.test(`UPDATE spaces SET kind = 'shared',\n  capabilities = capabilities || '{}'::jsonb WHERE id = $1`)).toBe(true);
    expect(WRITES.test(`UPDATE spaces s SET capabilities = $2 WHERE s.id = $1`)).toBe(true);
    expect(WRITES.test(`UPDATE spaces SET deleted_at = now() WHERE id = $1`)).toBe(false);
  });

  it("no file but services/spaces.ts writes spaces.capabilities", () => {
    const files = sourceFiles(SRC).map((path) => ({ rel: relative(SRC, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));
    expect(files.some((f) => f.rel === OWNER && WRITES.test(f.text))).toBe(true); // the scan still sees the owner's write
    expect(files.filter((f) => f.rel !== OWNER && WRITES.test(f.text)).map((f) => f.rel)).toEqual([]);
  });
});
