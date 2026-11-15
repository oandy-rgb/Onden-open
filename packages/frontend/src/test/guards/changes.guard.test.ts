// changes/ is what users read as 「這次更新」 (changes/README.md): every file must
// parse, and none may carry the technical words the UI rule keeps out of the interface.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChange } from "../../lib/whatsNew";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "changes");
const files = readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "README.md");

// PR numbers, hashes, file names and code, API paths, snake_case and constants.
const TECHNICAL = /#\d+|\b[0-9a-f]{7,40}\b|\.(tsx?|mjs|sql|json|md)\b|`|\/api\/|\b[a-z]+_[a-z_]+\b|\b[A-Z]{2,}_[A-Z_]+\b|\bPR\b|migration|commit/i;

describe("changes/*.md", () => {
  it("has at least one file", () => { expect(files.length).toBeGreaterThan(0); });
  for (const name of files) {
    it(`${name} parses and reads in plain words`, () => {
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/);
      const source = readFileSync(join(dir, name), "utf8");
      const change = parseChange(name.replace(/\.md$/, ""), source);
      expect(change, "needs date and zh-TW, and the name must start with the date").not.toBeNull();
      for (const text of [change!.zh, change!.en ?? ""]) expect(text).not.toMatch(TECHNICAL);
    });
  }
});
