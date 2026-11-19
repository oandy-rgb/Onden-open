// A read of a person's personal rows asks WHOSE rows through one function (spine/authority.ts personalDataOwnerId), so a temporary session reads the rows of the person who opened it and
// nobody else's (docs/architecture/proposals/sessions-reads-own-2026-11-17.md). Judged per FUNCTION, from the syntax tree, not from words in a file:
//
//   1. every function that reads a personal table (FROM / JOIN / selectFrom) is in READERS, said to be one of
//        "owner"  it calls personalDataOwnerId and names no other actor id (`actor.id`, `current.id`, `actorId`, `personId`) anywhere in its body: a second, raw read added to it is red;
//        a reason  it is not a read for a requester (a write path, a background job, a function that is handed the id): the reason says which and where the id comes from;
//      a function not in the list is red (a new reader has to choose), and a listed one that no longer reads, or whose kind no longer fits, is red (the list cannot go stale);
//   2. every CALL of a function that is handed the id (READ_HELPERS) gives it personalDataOwnerId(…), or is inside another such helper (it passes its own parameter on), or is listed.
// The self-tests below run the same scan over made-up source: a raw read added next to a good one, and a helper called with `actor.id`, must both come out red.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SRC = join(import.meta.dirname, "..", "..");
/** The tables of one person's own data, keyed by the actor. */
const PERSONAL = ["actor_prefs", "actor_module_settings", "review_states", "rss_seen", "rss_mutes", "external_calendars", "external_calendar_events", "focus_sessions"];
const READS = new RegExp(`(?:FROM|JOIN|selectFrom\\(")\\s*"?(?:${PERSONAL.join("|")})\\b`, "g");
const RAW_ID = /\b(?:actor|current)\.id\b|\bactorId\b|\bpersonId\b/;

// ratchet:list PERSONAL_READERS
const READERS: Record<string, string> = {
  "modules/external_calendars/store.ts::listCalendars": "owner",
  "modules/external_calendars/store.ts::getCalendar": "owner",
  "modules/external_calendars/store.ts::eventsBetween": "owner",
  "modules/external_calendars/store.ts::addCalendar": "write: runs in mutatePersonal, which refuses a session; keyed by the writer's own id",
  "modules/external_calendars/store.ts::removeCalendar": "write: runs in mutatePersonal, which refuses a session",
  "modules/external_calendars/store.ts::lastAttemptAt": "the refresh route's rate limit; the route is person-only (routes.ts person(), requirePerson) and passes the person's own id",
  "modules/external_calendars/store.ts::loadCalendarUrl": "background fetch: by calendar id, no requester",
  "modules/external_calendars/store.ts::dueCalendars": "background fetch: every due calendar, no requester",
  "modules/external_calendars/store.ts::saveFetchResult": "background fetch result: by calendar id, no requester",
  "modules/review/service.ts::loadEnrolledCards": "owner",
  "modules/review/service.ts::loadBlockCards": "owner",
  "modules/review/service.ts::personalSettings": "owner",
  "modules/review/service.ts::loadPersonalOverrides": "helper: handed the id (READ_HELPERS: its caller loadReviewTags is, and every call of that gives personalDataOwnerId)",
  "modules/review/seam.ts::copyProgress": "copies the schedules of a card that moved to its new place: a write of every person's rows, no requester",
  "modules/review/settings.ts::mergePersonalSettings": "write: called inside mutatePersonal (replaceSettings route), which refuses a session",
  "modules/review/settings.ts::clearPersonalSettings": "write: called inside mutatePersonal, which refuses a session",
  "modules/review/state.ts::lockReviewState": "write: FOR UPDATE inside mutatePersonal (grade), which refuses a session",
  "modules/review/state.ts::lockForUndo": "write: FOR UPDATE inside mutatePersonal (undo), which refuses a session",
  "modules/review/state.ts::stepBackReviewState": "write: inside mutatePersonal (undo), which refuses a session",
  "modules/review/state.ts::readReviewState": "helper: handed the id (READ_HELPERS; its one read caller, review/service.ts cardState, gives personalDataOwnerId)",
  "modules/rss/items.ts::seenSql": "helper: builds SQL over a placeholder the caller fills (READ_HELPERS: stagingCols/seenSql callers give personalDataOwnerId)",
  "modules/rss/mutes.ts::notMutedSql": "helper: builds SQL over a placeholder the caller fills (READ_HELPERS)",
  "modules/rss/mutes.ts::listMutes": "owner",
  "modules/rss/staging.ts::markSeen": "write: called inside mutatePersonal (rss routes, save.ts), which refuses a session",
  "modules/tasks/focus.ts::focusOfDay": "owner",
  "modules/tasks/focus.ts::ownRow": "write path: the lookup of the record that end/edit change, after requirePerson; keyed by the writer's own id",
  "modules/tasks/focus.ts::startFocus": "write path: the running-record check of a start, after requirePerson; keyed by the writer's own id",
  "services/actorPrefs.ts::readPrefOf": "helper: handed the id (READ_HELPERS: readPref gives personalDataOwnerId; services/harness/aiSkills.ts gives the token's issuer, listed there)",
  "services/actorPrefs.ts::writePrefStamped": "write: called inside mutatePersonal (writePref), which refuses a session",
  "services/backupExtras.ts::collectExtras": "the person's own backup: its one caller is services/backupArchive.ts:455 (readBackupFiles, reached from buildFullBackup/measureFullBackup), which only routes/backup.ts calls, through its person() whose line 43 is requirePerson(actor, \"backup\"): a session never gets there; keyed by that person's id",
};

/** Functions that are handed the person's id: every call must give personalDataOwnerId(…), or sit inside another one of these (passing its own parameter on), or be listed in HELPER_CALLERS. */
const READ_HELPERS = ["readReviewState", "loadPersonalOverrides", "loadReviewTags", "loadDailyLimit", "readPrefOf", "stagingCols", "seenSql", "notMutedSql"];
// ratchet:list PERSONAL_HELPER_CALLERS
const HELPER_CALLERS: Record<string, string> = {
  "services/harness/aiSkills.ts": "reads the preference of the TOKEN'S issuer (an AI acting for a person), by that person's id: not a session's read",
};

type Found = { fn: string; usesOwner: boolean; usesRawId: boolean };
type Call = { helper: string; inside: string; gives: boolean };

function functionsOf(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}
const isFn = (n: ts.Node): n is ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);
function nameOf(fn: ts.Node): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.getText();
  return fn.parent && ts.isVariableDeclaration(fn.parent) ? fn.parent.name.getText() : "(anonymous)";
}
/** The outermost function (declaration or const arrow) around `pos`. */
function outermost(sf: ts.SourceFile, pos: number): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (n: ts.Node) => {
    if (pos < n.getStart(sf) || pos >= n.getEnd()) return;
    if (isFn(n) && found === null) found = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Every function of `text` that reads a personal table, and what it does about whose rows. */
export function readersIn(file: string, text: string): Found[] {
  const sf = functionsOf(file, text);
  const byName = new Map<string, Found>();
  for (const m of text.matchAll(READS)) {
    const fn = outermost(sf, m.index!);
    const body = fn ? fn.getText(sf) : "";
    byName.set(fn ? nameOf(fn) : "(module)", { fn: fn ? nameOf(fn) : "(module)", usesOwner: /\bpersonalDataOwnerId\(/.test(body), usesRawId: RAW_ID.test(body) });
  }
  return [...byName.values()];
}

/** Every call of a READ_HELPER in `text`, and whether it hands over personalDataOwnerId(…). */
export function helperCallsIn(file: string, text: string): Call[] {
  const sf = functionsOf(file, text);
  const out: Call[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && READ_HELPERS.includes(n.expression.text)) {
      const around = outermost(sf, n.getStart(sf));
      out.push({ helper: n.expression.text, inside: around ? nameOf(around) : "(module)", gives: n.arguments.some((a) => /\bpersonalDataOwnerId\(/.test(a.getText(sf)) || (ts.isStringLiteral(a) && a.text.startsWith("$"))) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** What is wrong with these readers, given the list: a message per problem. */
export function problemsOf(file: string, found: Found[], readers: Record<string, string>): string[] {
  const out: string[] = [];
  for (const f of found) {
    const key = `${file}::${f.fn}`;
    const kind = readers[key];
    if (kind === undefined) out.push(`${key} reads a personal table and is not in READERS: ask personalDataOwnerId(actor) (a session reads the person who opened it), or list it with why it is not a read for a requester`);
    else if (kind === "owner" && !f.usesOwner) out.push(`${key} is listed as "owner" but does not call personalDataOwnerId`);
    else if (kind === "owner" && f.usesRawId) out.push(`${key} calls personalDataOwnerId but also names a raw actor id (actor.id / current.id / actorId / personId): every personal read in it must use the one function`);
    else if (kind !== "owner" && f.usesOwner) out.push(`${key} is listed with a reason but calls personalDataOwnerId: list it as "owner"`);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && name !== "dbSchema.generated.ts" ? [path] : [];
  });
}
const sources = sourceFiles(SRC).map((path) => ({ file: relative(SRC, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));

describe("personal rows are read for the person the requester reads for", () => {
  const all = sources.filter(({ text }) => { READS.lastIndex = 0; return READS.test(text); }).map(({ file, text }) => ({ file, found: readersIn(file, text) }));

  it("finds the readers (the scan is not blind)", () => {
    const names = all.flatMap(({ file, found }) => found.map((f) => `${file}::${f.fn}`));
    expect(names).toEqual(expect.arrayContaining(["services/actorPrefs.ts::readPrefOf", "modules/rss/mutes.ts::listMutes", "modules/external_calendars/store.ts::eventsBetween", "modules/tasks/focus.ts::focusOfDay"]));
  });

  it("every function that reads a personal table is listed, and does what its listing says", () => {
    expect(all.flatMap(({ file, found }) => problemsOf(file, found, READERS))).toEqual([]);
  });

  it("the list names only functions that still read a personal table (it cannot go stale)", () => {
    const present = new Set(all.flatMap(({ file, found }) => found.map((f) => `${file}::${f.fn}`)));
    expect(Object.keys(READERS).filter((key) => !present.has(key))).toEqual([]);
  });

  it("every call of a function that is handed the person's id gives personalDataOwnerId(…), passes its own parameter on, or is listed", () => {
    const bad: string[] = [];
    for (const { file, text } of sources) {
      for (const call of helperCallsIn(file, text)) {
        if (call.gives || READ_HELPERS.includes(call.inside) || file in HELPER_CALLERS) continue;
        // a definition's own file may call a sibling helper from a function it hands the id to (readPref → readPrefOf is the first case: it gives)
        bad.push(`${file}: ${call.inside} calls ${call.helper}(…) without personalDataOwnerId(…)`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the helper-caller list names only files that still call a helper", () => {
    const calling = new Set(sources.filter(({ file, text }) => helperCallsIn(file, text).length > 0).map((s) => s.file));
    expect(Object.keys(HELPER_CALLERS).filter((file) => !calling.has(file))).toEqual([]);
  });

  describe("self-test: the scan is red where it should be (made-up source)", () => {
    const good = `
      export async function readPref(actor, key) { return q("SELECT value FROM actor_prefs WHERE actor_id = $1", [personalDataOwnerId(actor)]); }
    `;
    const rawAdded = `
      export async function readPref(actor, key) {
        const a = await q("SELECT value FROM actor_prefs WHERE actor_id = $1", [personalDataOwnerId(actor)]);
        const b = await q("SELECT value FROM actor_prefs WHERE actor_id = $1 AND key = 'x'", [actor.id]);
        return a ?? b;
      }
    `;
    const newReader = `export async function listEverything(actor) { return q("SELECT * FROM focus_sessions WHERE actor_id = $1", [personalDataOwnerId(actor)]); }`;
    const list = { "x.ts::readPref": "owner" };
    it("a good reader is clean", () => expect(problemsOf("x.ts", readersIn("x.ts", good), list)).toEqual([]));
    it("a raw `actor.id` read added to a function that already asks the function is red", () => {
      expect(problemsOf("x.ts", readersIn("x.ts", rawAdded), list).join("\n")).toContain("names a raw actor id");
    });
    it("a new function that reads a personal table is red until it chooses", () => {
      expect(problemsOf("x.ts", readersIn("x.ts", newReader), list).join("\n")).toContain("not in READERS");
    });
    it("a helper called with the requester's own id is red; with personalDataOwnerId it is clean", () => {
      const raw = helperCallsIn("y.ts", `function a(actor) { return loadDailyLimit(actor.id); }`);
      const ok = helperCallsIn("y.ts", `function a(actor) { return loadDailyLimit(personalDataOwnerId(actor)); }`);
      expect(raw.map((c) => c.gives)).toEqual([false]);
      expect(ok.map((c) => c.gives)).toEqual([true]);
    });
  });
});
