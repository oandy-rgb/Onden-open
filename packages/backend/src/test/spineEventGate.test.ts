// Architecture guard: the spine is the single mutation gate. Direct event()
// emission (calling `event` from db.js) is allowed ONLY for the documented
// categories below — everything else must go through spine mutate(), which
// enforces actor, authority, and atomicity by construction.
//
// The legitimate-bypass taxonomy (each entry says WHY it may emit raw events):
//   cascade   child events inside a dispatcher/template cascade — they inherit
//             the root actor via AsyncLocalStorage and link triggered_by
//   system    server-detected facts the spine deliberately can't mint
//             (actor_type='system' — conflicts, missed schedules)
//   external  records of side effects that already happened (ER4: restore
//             must not "undo" them)
//   audit     observation-only records, no state change
//
// Event restore is not a category: its inverse events go through spine
// mutateRestore (runRestore opens the root), like any other write.
//
// Adding a file to this list is an architecture decision: justify the
// category in the PR, don't just append.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

const ALLOWED: Record<string, string> = {
  "services/attributeWrites.ts": "system — ATTRIBUTE_CONFLICT server-detected, triggered_by-linked",
  "services/adminAccounts.ts": "system — ADMIN_PASSWORD_RESET / ADMIN_SESSIONS_REVOKED from the container admin CLI (no signed-in actor); written in the same transaction as the auth-table change",
  "services/nodeUpdate.ts": "system — BODY_CONFLICT moved from the node PATCH; recorded inside the authorized NODE_UPDATED transaction",
  // modules/website/publishing/snapshot.ts left this list (PR #1875): PUBLISH_SNAPSHOT_CREATED goes through appendEventAsCurrentActor,
  // inside the same transaction as the snapshot row and the pages push (external=true is an event option, not a reason to bypass).
  // P3.2: the cascade category is now EMPTY. tagDispatcher / builtinHandlers /
  // fieldDefaults / templateExpander / tagHierarchy all route their events
  // through spine mutate (runCascade + {kind:"cascade"}, or {open} for genuine
  // un-gated creates) — the by-construction single-rail goal. dispatcherQueue
  // stays a direct emitter but is NOT a cascade: it only mints DISPATCHER_FAILED
  // with actor_type='system' (a post-commit / catch-up failure with no acting
  // user), which is the spine's documented system carve-out, so it's recategorized.
  "services/dispatcherQueue.ts": "system — DISPATCHER_FAILED, actor_type='system' post-commit/catch-up failure audit, no acting user; signed by the queued actor, or REMOVED_ACTOR_REF when that actor was removed since (spine/currentActor.ts signatureForCapturedActor, under the event lock)",
  "services/blockAnchors/store.ts": "audit — BLOCK_ANCHOR_* records of an anchor created or changing state, written inside the transaction of the save (or the caller) that caused it, attributed to that actor; deliberately not triggered_by the edit, so undoing the edit neither lists nor undoes them (the restore moves the anchors itself)",
  "services/blockNodes.ts": "cascade — BLOCK_NODE_* events derived from a note's body, recorded inside that save's transaction, triggered_by its event",
  "services/agentSessionStore.ts": "system — AGENT_SESSION_ENDED, a server-detected fact (timeout sweep, kill switch, cancel, finish) emitted in the same transaction as the status change",
  // services/agentTools/registry.ts left this list (PR #1875): its tool-call audit records go through spine/currentActor.ts
  // appendEventAsCurrentActor, which re-reads the actor under the event lock like mutate() does.
  "services/tagPacks.ts": "approved-effect — TAG_IMPORTED from the outbox drain; authorization is the principal admin's EFFECT_APPROVED, attributed to the proposing agent, or to the system (REMOVED_ACTOR_REF, the agent's id in the payload) when the agent was removed after proposing (spine/currentActor.ts signatureForCapturedActor, under the event lock). Also installTagPack's TAG_DEPENDENCY_MISSING warnings ('system'), inside its principal_admin mutate (moved from routes/tags.ts, D13)",
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // spine/ owns event(); test/ exercises it freely.
      if (entry.name === "test" || entry.name === "spine" || entry.name === "node_modules") return [];
      return walk(full);
    }
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Static imports from db.js that bring in the `event` binding. */
export function importsEvent(text: string): boolean {
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/db\.js["']/g)) {
    const bindings = m[1]!.split(",").map((b) => b.trim().split(/\s+as\s+/)[0]!.trim());
    if (bindings.includes("event")) return true;
  }
  return false;
}

/** A call `event(` outside comments and the import line (not `.event(`, not `myevent(`). */
export function callsEvent(text: string): boolean {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']*["'];?/g, "");
  return /(^|[^.\w$])event\s*\(/.test(code);
}

function eventFiles(): { importers: string[]; callers: string[] } {
  const importers: string[] = [];
  const callers: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    if (rel === "db.ts") continue; // the definition itself
    const text = readFileSync(file, "utf8");
    if (!importsEvent(text)) continue;
    importers.push(rel);
    if (callsEvent(text)) callers.push(rel);
  }
  return { importers: importers.sort(), callers: callers.sort() };
}

describe("spine event gate (single-gate audit)", () => {
  it("only the documented allowlist calls event() from db.js", () => {
    const { callers: found } = eventFiles();
    const allowed = Object.keys(ALLOWED).sort();

    const undocumented = found.filter((f) => !(f in ALLOWED));
    expect(
      undocumented,
      `New direct event() emitter(s) outside the spine: ${undocumented.join(", ")}.\n` +
        `Either route the mutation through spine mutate(), or add the file to\n` +
        `ALLOWED in this test with its bypass category (cascade/system/external/audit).`,
    ).toEqual([]);

    // Allowlist hygiene: entries must not outlive their call sites. Judged on
    // calls, not imports: an import left behind after the last call is not an emitter.
    const stale = allowed.filter((f) => !found.includes(f));
    expect(
      stale,
      `Allowlist entries with no event() call anymore (remove them): ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("no file imports event() without calling it", () => {
    const { importers, callers } = eventFiles();
    expect(importers.filter((f) => !callers.includes(f)), "dead event import — remove it").toEqual([]);
  });

  it("the detectors tell a call from a dead import", () => {
    const deadImport = `import { pool, event } from "../db.js";\n// event(x) in a comment\nawait pool.query("select 1");`;
    expect(importsEvent(deadImport)).toBe(true);
    expect(callsEvent(deadImport)).toBe(false);
    expect(callsEvent(`import { event } from "../db.js";\nawait event(client, {});`)).toBe(true);
    expect(callsEvent(`import { event } from "../db.js";\nbus.event(x); prevent(y);`)).toBe(false);
  });
});
