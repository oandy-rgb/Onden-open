// @vitest-environment node
// Guard: no e2e script writes the client protocol number by hand. The app's pages send CLIENT_PROTOCOL (@onden/markdown) and the
// server refuses any other number with 426; the parity runner had "3" written in it and stopped at its first write when the number
// became 4. A script reads the number from packages/markdown/src/sharedContract.ts (e2e/parity/hosts/common.mjs shows how).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const E2E = join(dirname(fileURLToPath(import.meta.url)), "../../../e2e");

function scripts(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(path).isDirectory()) return scripts(path);
    return /\.(mjs|ts|js)$/.test(name) ? [path] : [];
  });
}

describe("e2e scripts and the client protocol", () => {
  it("none sends a protocol number written by hand", () => {
    const bad = scripts(E2E).filter((file) => /client-protocol["']?\s*[:,]\s*["']?\d/i.test(readFileSync(file, "utf8")));
    expect(bad.map((file) => file.slice(E2E.length + 1))).toEqual([]);
  });
});
