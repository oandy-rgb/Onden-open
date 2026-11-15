// Allow-list guards from docs/research/dup-patterns-2026-10-30-be.md (batch 2:
// R4, R7, R10, R12). Each rule names the file that may do the job; any other
// file fails. Exception lists only shrink: a listed entry that no longer
// violates must be removed (the test fails until it is).

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}
type Src = { file: string; text: string };
const files: Src[] = sourceFiles(SRC).map((path) => ({ file: relative(SRC, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));

// Blank comments (newlines kept) so prose never counts as code.
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));

/** file -> number of matches, for the files outside `owners` that have any. */
function countOutside(list: Src[], pattern: RegExp, owners: (file: string) => boolean, strip = true): Record<string, number> {
  const found: Record<string, number> = {};
  for (const { file, text } of list) {
    if (owners(file)) continue;
    const n = [...(strip ? stripComments(text) : text).matchAll(pattern)].length;
    if (n > 0) found[file] = n;
  }
  return found;
}

/** An exception list that may only shrink: every entry must still be needed, and nothing new may appear. */
function expectExactly(actual: Record<string, number>, allowed: Record<string, { count: number; reason: string }>, rule: string) {
  const unlisted = Object.keys(actual).filter((f) => !(f in allowed) || actual[f] > allowed[f].count);
  expect(unlisted, `${rule}: new violations (use the one entry point; the exception list only shrinks)`).toEqual([]);
  const stale = Object.keys(allowed).filter((f) => (actual[f] ?? 0) < allowed[f].count);
  expect(stale, `${rule}: exception no longer needed — lower or remove it`).toEqual([]);
  for (const [f, e] of Object.entries(allowed)) expect(e.reason.trim(), `${rule}: ${f} needs a reason`).not.toBe("");
}

// ── R4: "a person, not a token" ─────────────────────────────────────────────
// spine/authority.ts requirePerson / isPerson refuse a delegated token with
// one answer (403, AuthorityError). Nobody else turns `.tokenScope` straight
// into a throw/return.
const TOKEN_REFUSAL = /if \([^)\n]*\.tokenScope[^)\n]*\)\s*(?:\{\s*)?(?:throw|return)/g;
// ratchet:list R4_EXCEPTIONS
const R4_EXCEPTIONS: Record<string, { count: number; reason: string }> = {
  "spine/currentActor.ts": { count: 1, reason: "identity check (a token row without its id is unauthenticated, 401), not a person-only operation" },
  "services/ownerTransfer.ts": { count: 1, reason: "answers the frontend-translated owner_only code before any lookup; same body as the owner check below it" },
  "services/eventVisibility.ts": { count: 1, reason: "not a refusal: a token reads events by another rule" },
  "services/sync/delta.ts": { count: 1, reason: "not a refusal: a token has no personal sync rows" },
  "services/agentSessions.ts": { count: 4, reason: "R4 in-flight: file belongs to open PRs (ai-runtime-api); 404 vs 403 per route to be decided there" },
  "services/agentTools/updateNode.ts": { count: 1, reason: "not a refusal: an agent in suggest mode files the same edit as a suggestion" },
  "spine/toolScope.ts": { count: 1, reason: "not a refusal: only an agent in suggest mode is gated below; everyone else passes" },
};
describe("R4 only a person, not a token — requirePerson is the one refusal", () => {
  it("no file but spine/authority.ts turns .tokenScope straight into a throw/return", () => {
    expectExactly(countOutside(files, TOKEN_REFUSAL, (f) => f === "spine/authority.ts"), R4_EXCEPTIONS, "R4");
  });
  it("finds a planted copy", () => {
    const planted = [{ file: "services/x.ts", text: 'if (actor.tokenScope) throw new AuthorityError("x", "no");' }];
    expect(countOutside(planted, TOKEN_REFUSAL, () => false)).toEqual({ "services/x.ts": 1 });
  });
});

// ── R7: hand-written 4xx bodies ─────────────────────────────────────────────
// A refusal in a route is `throw new StatusError(status, message)` /
// CodedStatusError; apiOnError (httpError.ts) answers it. Routes do not spell
// `c.json({ error: "..." }, 4xx)` themselves. The baseline only shrinks.
const HAND_WRITTEN_4XX = /c\.json\(\s*\{\s*error:\s*"[^"]*"\s*\}\s*,\s*(?:400|403|404|409|410|413|422)\s*\)/g;
// ratchet:list R7_BASELINE
const R7_BASELINE: Record<string, { count: number; reason: string }> = {
  "routes/nodes.ts": { count: 6, reason: "five `row ? c.json(row) : c.json({ error }, 404)` ternaries, and note_exists inside the create try/catch" },
  "routes/media.ts": { count: 5, reason: "R7 in-flight: file belongs to open PRs" },
  "modules/rss/routes.ts": { count: 5, reason: "R7 in-flight: file belongs to open PRs" },
  "modules/website/routes.ts": { count: 3, reason: "public site routes: mounted outside the API error boundary, answer with their own bodies" },
  "routes/history.ts": { count: 2, reason: "ternary `note ? c.json(note) : c.json({ error }, 404)`; becomes an if/throw when History routes are next touched" },
  "routes/tags.ts": { count: 2, reason: "ternary `row ? c.json(row) : c.json({ error }, 404)`; same" },
};
describe("R7 refusals are thrown, not hand-written", () => {
  it("only httpError.ts and app.ts spell a 4xx { error } body; the rest is a shrinking baseline", () => {
    expectExactly(countOutside(files, HAND_WRITTEN_4XX, (f) => f === "httpError.ts" || f === "app.ts", false), R7_BASELINE, "R7");
  });
  it("finds a planted copy", () => {
    const planted = [{ file: "routes/x.ts", text: 'return c.json({ error: "tag not found" }, 404);' }];
    expect(countOutside(planted, HAND_WRITTEN_4XX, () => false)).toEqual({ "routes/x.ts": 1 });
  });
});

// ── R10: error classes ──────────────────────────────────────────────────────
// A new refusal class extends StatusError / CodedStatusError (statusError.ts).
// `extends Error` is for non-HTTP errors and the spine's own; the list below
// is the not-yet-migrated baseline and only shrinks.
const EXTENDS_ERROR = /\bextends Error\b/g;
const R10_OWNERS = new Set(["statusError.ts", "spine/authorityError.ts", "spine/actor.ts", "spine/idempotency.ts", "spine/toolScope.ts"]);
const R10_REASON = "R10 baseline: body differs from StatusError (extra fields / code-only body) or not an HTTP refusal; migrate with its httpError.ts branch";
const R10_BASELINE: Record<string, { count: number; reason: string }> = Object.fromEntries(Object.entries({
  "db.ts": 1, // DatabaseNewerThanCodeError: a boot refusal (server.ts exits), not an HTTP one
  "modules/importers/obsidian/folders.ts": 1,
  "modules/rss/destination.ts": 1,
  "modules/rss/sourceSpace.ts": 1,
  "modules/website/publishing/staticSite.ts": 1,
  "services/actorInvites.ts": 1,
  "services/actors.ts": 1,
  "services/adminAccounts.ts": 1,
  "services/agentSessionError.ts": 1,
  "services/aiSessionStart.ts": 1,
  "services/agentSessions.ts": 1,
  "services/agentRuntime/api/prepare.ts": 1,
  "services/agentTools/rateLimit.ts": 1,
  "services/archiveStream.ts": 1,
  "services/attributeChange.ts": 1,
  "services/backupFile.ts": 3,
  "services/backupRestore.ts": 1,
  "services/blockChildNote.ts": 1,
  "services/eventRestore/restore.ts": 1,
  "services/eventReview.ts": 2,
  "services/fieldSchema.ts": 1,
  "services/harness/index.ts": 1,
  "services/harness/scope.ts": 1,
  "services/history/rewind.ts": 1,
  "services/nodeTrash.ts": 1,
  "services/nodeTree.ts": 1,
  "services/nodeUpdate.ts": 1,
  "services/noteCreate.ts": 1,
  "services/noteDuplicate.ts": 1,
  "services/noteSize.ts": 1,
  "services/outbox.ts": 3,
  "services/reservedTags.ts": 1,
  "services/safeFetch.ts": 1,
  "services/sync/membership.ts": 1,
  "services/tagFields.ts": 1,
  "services/tagHierarchy.ts": 1,
  "services/tagMerge.ts": 1,
  "services/tagPacks.ts": 1,
  "services/tagViews.ts": 1,
  "services/taskSeam.ts": 1,
  "services/viewModules.ts": 1,
  "services/workspaceModules.ts": 1,
  "services/workspaceTime.ts": 1,
}).map(([file, count]) => [file, { count, reason: R10_REASON }]));
describe("R10 refusal classes extend StatusError", () => {
  it("`extends Error` is only the owners' or in the shrinking baseline", () => {
    expectExactly(countOutside(files, EXTENDS_ERROR, (f) => R10_OWNERS.has(f)), R10_BASELINE, "R10");
  });
  it("httpError.ts does not grow more instanceof branches", () => {
    const text = files.find((f) => f.file === "httpError.ts")!.text;
    expect([...stripComments(text).matchAll(/\binstanceof\b/g)].length).toBeLessThanOrEqual(45);
  });
  it("finds a planted copy", () => {
    const planted = [{ file: "services/x.ts", text: "export class XError extends Error {}" }];
    expect(countOutside(planted, EXTENDS_ERROR, () => false)).toEqual({ "services/x.ts": 1 });
  });
});

// ── R12: "which of these ids can I read" ────────────────────────────────────
// readPolicy.readableAmong is the live check. History's trash-aware variant
// (rewind.ts readableNotes, agentRuns.ts) still spells the SELECT itself:
// moving it into history/readableNotes.ts needs eslint-rules/require-read-gate.js
// (GATED / EVENT_READS lists), a file open PRs are changing, so the baseline
// below holds until they land. No new copy may appear.
const READABLE_FN = /\b(?:function|const)\s+readable\w*Among\b|\b(?:function|const)\s+readableNotes\b/g;
const READABLE_SELECT = /::text\s*=\s*ANY\(\$2::text\[\]\)\s*AND\s*\$\{readable/g;
const R12_OWNERS = new Set(["services/readPolicy.ts", "services/history/readableNotes.ts"]);
const R12_REASON = "R12 baseline: trash-aware batch filter; move to history/readableNotes.ts once require-read-gate.js is free of open PRs";
describe("R12 batch read filters live in readPolicy / history readableNotes", () => {
  it("no new readable*Among / readableNotes batch filter", () => {
    expectExactly(countOutside(files, READABLE_FN, (f) => R12_OWNERS.has(f)), {
      "services/history/rewind.ts": { count: 1, reason: R12_REASON },
    }, "R12");
  });
  it("the readable-subset SELECT is not spelled in a new place", () => {
    expectExactly(countOutside(files, READABLE_SELECT, (f) => R12_OWNERS.has(f)), {
      "services/history/agentRuns.ts": { count: 1, reason: R12_REASON },
    }, "R12");
  });
  it("finds planted copies", () => {
    expect(countOutside([{ file: "services/x.ts", text: "async function readableThings(" }, { file: "services/y.ts", text: "async function readableFooAmong(" }], READABLE_FN, () => false))
      .toEqual({ "services/y.ts": 1 });
    expect(countOutside([{ file: "services/x.ts", text: "n.id::text = ANY($2::text[]) AND ${readable}" }], READABLE_SELECT, () => false)).toEqual({ "services/x.ts": 1 });
  });
});
