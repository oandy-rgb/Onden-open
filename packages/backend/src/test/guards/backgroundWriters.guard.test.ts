// Everything that can touch the database after a commit or on a timer must be stopped and waited for before the pool ends
// (dbClose.ts onBeforePoolEnd), or be listed here with the reason it cannot write. A new timer, post-commit hook or
// periodic job in product code that does neither fails this test: the way a job that outlives its test was found
// (public CI run 44083441388, "Cannot use a pool after calling end on the pool") was by luck, in a later test file.
//
// Scans product code (not tests) for setTimeout / setInterval / setImmediate / queueMicrotask / startTicker / afterCommit.
// startPeriodicJob is covered once, by backgroundJobs.ts registering "periodic-jobs" (checked below).
// A bare `void fn()` is not scanned (too many, and most are not writers); the runtime backstop is the pool itself:
// a query after pool.end() throws on Postgres, naming the stack of the caller.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");
const TIMER_OR_HOOK = /\b(setTimeout|setInterval|setImmediate|queueMicrotask|startTicker|afterCommit)\(/;

// Files that use one of them and do not register. The reason says why it cannot write to the database after the pool ends.
// Only shrinks (scripts/ratchetLib.mjs); a file that stops matching must be removed from here (checked below).
// ratchet:list backgroundWriterExceptions
const EXCEPTIONS: Record<string, string> = {
  "db.ts": "afterCommit only notifies in-memory listeners (realtime ticks)",
  "dbPglite.ts": "the connect timeout of the pool itself",
  "routes/aiRuntime.ts": "a 500 ms pause inside a request; no database access of its own",
  "routes/mcpSessions.ts": "an in-connection wait for a message; no database access",
  "services/agentRuntime/api/liveRun.ts": "forgets an in-memory run record; no database access",
  "services/bodySideEffects.ts": "afterCommit only calls queueDispatcher, which registers",
  "services/media.ts": "afterCommit deletes a file from disk; no database access, errors are logged",
  "services/realtime.ts": "coalesces ticks and a heartbeat to in-memory listeners; no database access",
  "services/workspaceTime.ts": "afterCommit only swaps the in-memory clock; its periodic reload runs as a periodic job",
  "spine/txHooks.ts": "the afterCommit mechanism itself; each callback is reviewed where it is registered",
  "ticker.ts": "the one owner of setInterval; callers are listed or register",
  "browser/saveLoop.ts": "browser host: saves a copy to IndexedDB; the host never ends its pool (a reset clears stored copies only)",
  "browser/worker.ts": "browser host: a short wait inside the worker; it never ends its pool",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" || name === "node_modules" ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const code = (text: string) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

const files = sourceFiles(SRC).map((path) => ({ rel: relative(SRC, path).split(sep).join("/"), text: code(readFileSync(path, "utf8")) }));
const using = files.filter((f) => TIMER_OR_HOOK.test(f.text));

describe("background writers register before the pool ends", () => {
  it("every file with a timer or post-commit hook registers with onBeforePoolEnd or is listed with a reason", () => {
    const loose = using.filter((f) => !/\bonBeforePoolEnd\(/.test(f.text) && !(f.rel in EXCEPTIONS)).map((f) => f.rel);
    expect(loose, `${loose.join(", ")}: register what it starts with onBeforePoolEnd (dbClose.ts), or add it to EXCEPTIONS with the reason it cannot write`).toEqual([]);
  });

  it("the exception list has no file that stopped using a timer or hook, or that registers after all", () => {
    const stale = Object.keys(EXCEPTIONS).filter((rel) => {
      const f = using.find((u) => u.rel === rel);
      return !f || /\bonBeforePoolEnd\(/.test(f.text);
    });
    expect(stale, `${stale.join(", ")}: remove from EXCEPTIONS`).toEqual([]);
  });

  it("periodic jobs are stopped and waited for in one place", () => {
    const jobs = files.find((f) => f.rel === "backgroundJobs.ts")!;
    expect(jobs.text).toMatch(/onBeforePoolEnd\("periodic-jobs"/);
  });
});
