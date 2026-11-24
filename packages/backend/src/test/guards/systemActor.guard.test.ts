// Two doors to 'system' in the event log, both fixed by a list here.
//
//  1. A system actor (spine/systemJobs.ts) is made by systemActorFor(); only
//     the background jobs below may import it. Nothing on the request path can.
//  2. event() called directly with actor_type 'system' is an audit record
//     written BESIDE someone else's operation. Each file is listed with why it
//     is not a system job. A listed file that no longer does it fails too, so
//     the list cannot go stale.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");

// ratchet:list SYSTEM_ACTOR_USERS
const SYSTEM_ACTOR_USERS: Record<string, string> = {
  "spine/systemJobs.ts": "the one definition",
  "modules/tasks/scheduler.ts": "the task-scheduler job: a timer, no person behind it",
  "services/blockMarkerRepair.ts": "the block-marker-repair job: puts a tagged paragraph's `{…} ^id` back after typed-under text split it; a timer, no person behind it",
  "spine/stampedImport.ts": "the change-bundle-inbox job: takes a bundle another node sent in segments, and goes on with it at start-up and on a timer; a node sends it, no person behind it; its one authority clears the inbox",
};

// ratchet:list DIRECT_SYSTEM_EVENTS
const DIRECT_SYSTEM_EVENTS: Record<string, string> = {
  "services/dispatcherQueue.ts": "DISPATCHER_FAILED: the failure record of a person's or agent's operation whose follow-up work broke, signed with that actor's id (REMOVED_ACTOR_REF when that actor has been removed since: spine/currentActor.ts signatureForCapturedActor)",
  "services/nodeUpdate.ts": "BODY_CONFLICT: the server noticed the save overwrote a newer edit; a note beside the person's NODE_UPDATED, linked triggered_by it",
  "services/attributeWrites.ts": "ATTRIBUTE_CONFLICT: same, beside the person's ATTRIBUTE_SET",
  "services/agentSessionStore.ts": "AGENT_SESSION_ENDED: a server-detected end (timeout, cap) of a session a person started; part of that session's story, not a job of its own",
  "services/tagPacks.ts": "TAG_DEPENDENCY_MISSING: a note inside the person's pack install that a dependency was absent. (Its TAG_IMPORTED of an approved proposal is signed 'system' only when the proposing agent was removed after proposing: spine/currentActor.ts signatureForCapturedActor.)",
  "services/adminAccounts.ts": "ADMIN_PASSWORD_RESET / ADMIN_SESSIONS_REVOKED: the self-host admin CLI (dist/admin.js, run inside the container, never over HTTP); the operator at the console has no Onden actor, so the audit record is signed ADMIN_CLI_ACTOR_ID",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}
const rel = (path: string) => relative(SRC, path).split("\\").join("/");
const files = sourceFiles(SRC).map((path) => ({ file: rel(path), text: readFileSync(path, "utf8") }));

describe("who may be, or write as, 'system'", () => {
  it("only the listed files use systemActorFor", () => {
    const using = files.filter((f) => /\bsystemActorFor\b/.test(f.text)).map((f) => f.file).sort();
    expect(using).toEqual(Object.keys(SYSTEM_ACTOR_USERS).sort());
  });

  it("only the listed files call event() with 'system' directly", () => {
    const writing = files
      .filter((f) => [...f.text.matchAll(/(?<!function )\bevent\(([^;]*?)\);/gs)].some((m) => m[1]!.includes('"system"')))
      .map((f) => f.file).sort();
    expect(writing).toEqual(Object.keys(DIRECT_SYSTEM_EVENTS).sort());
  });
});
