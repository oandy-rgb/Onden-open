// @vitest-environment node
// Guard: an answer that carries rows reaches the local copy and the store through ONE door (lib/data/writePositions.ts
// takeAnswer, by way of syncEngine's applyAndShow / takeBootstrap), where it is judged by the watermark
// (lib/answerPositions.ts isCurrentAnswer). Owner report 2026-11-16 and review on #1794.
// (1) Outside their own definitions, the calls that put server rows into the copy (localDb applySync, persistBootstrap,
//     persistRemoteNode — a single note read) and into the store (storeOps applySyncDelta) appear only inside a
//     `toCopy` / `toStore` callback handed to takeAnswer (lib/data/syncEngine.ts, lib/data/serverTruth.ts).
// (2) Nothing in the app compares a server time to decide which copy of a row is newer (the rule of PR #1753).
// (3) Every answer that carries rows says where it was read: the contract's SyncDelta.head_event_id is required, and
//     the bootstrap and membership answers carry last_event_id / event_cursor.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CONTRACT = join(SRC, "../../contract/src/bootstrap.ts");
/** The files that define these functions (and the worker that implements the copy's side). */
const DEFINITIONS = new Set(["lib/localDb.ts", "lib/localDbWorker.ts", "lib/data/storeOps.ts"]);
const ENTRY = /\b(applySync|persistBootstrap|persistRemoteNode|applySyncDelta)\(/;
/** The files that hand answers to takeAnswer. */
const DOOR_CALLERS = new Set(["lib/data/syncEngine.ts", "lib/data/serverTruth.ts"]);

function productFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : productFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("one door for answers", () => {
  it("server rows reach the copy and the store only inside takeAnswer's callbacks", () => {
    const outside: string[] = [];
    for (const file of productFiles(SRC)) {
      const name = relative(SRC, file);
      if (DEFINITIONS.has(name)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!ENTRY.test(line) || /^\s*(\/\/|\*)/.test(line) || /\bfunction (applySync|persistBootstrap|persistRemoteNode|applySyncDelta)\b/.test(line)) return;
        const inCallback = DOOR_CALLERS.has(name) && lines.slice(Math.max(0, i - 3), i + 1).some((l) => /\b(toCopy|toStore):/.test(l));
        if (!inCallback) outside.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(outside, "hand the answer to takeAnswer (lib/data/writePositions.ts) instead").toEqual([]);
  });

  it("no copy of a row is judged by the server's clock", () => {
    const byTime = productFiles(SRC).filter((file) => /isOlderCopy|Date\.parse\(incoming\.updated_at/.test(readFileSync(file, "utf8")));
    expect(byTime.map((file) => relative(SRC, file))).toEqual([]);
  });

  it("every answer that carries rows says where it was read", () => {
    const text = readFileSync(CONTRACT, "utf8");
    const delta = text.slice(text.indexOf("export type SyncDelta = {"));
    expect(delta.slice(0, delta.indexOf("\n};"))).toMatch(/^ {2}head_event_id: string;/m);
    expect(text).toMatch(/^ {2}last_event_id\?: string;/m); // the bootstrap (absent only on locally made data)
    const membership = readFileSync(join(SRC, "lib/data/membershipReconcile.ts"), "utf8");
    expect(membership).toMatch(/event_cursor: string/);
  });
});
