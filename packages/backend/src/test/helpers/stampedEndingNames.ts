// What the setup file (test/stampedEndingSetup.ts) needs of the ending without loading it (helpers/stampedEnding.ts imports the engine): the names the exception
// lists use, and which exports of spine/stampedImport.ts it wraps.
import { basename } from "node:path";

export type Test = { name: string; suite?: { name: string; suite?: unknown } | undefined; file?: { name: string }; result?: { state?: string } };

/** "file > describe > … > test", the key of the exception lists. */
export function fullName(test: Test): string {
  const parts = [test.name];
  for (let s = test.suite as { name: string; suite?: unknown } | undefined; s && s.name; s = s.suite as typeof s) parts.unshift(s.name);
  return [basename(test.file?.name ?? "?"), ...parts].join(" > ");
}

/** The entry of `list` for test `name`: its own, or one ending in " > *" that names a describe (or a file) it is in. */
export function exceptionEntryFor<T>(list: Record<string, T>, name: string): T | undefined {
  if (list[name] !== undefined) return list[name];
  const prefix = Object.keys(list).find((k) => k.endsWith(" > *") && name.startsWith(k.slice(0, -1)));
  return prefix ? list[prefix] : undefined;
}

/** The keys of `lists` that belong to `file` (a basename) and name none of its tests: a test or describe renamed or taken out leaves an entry that pins or skips
 *  nothing, and a test under its new name runs with no entry (the setup file checks every file that ran against these, test/stampedEndingSetup.ts afterAll). */
export function keysNamingNothing(file: string, testNames: readonly string[], lists: Record<string, Record<string, unknown>>): string[] {
  const outside = `${file} > (outside a test)`;
  return Object.entries(lists).flatMap(([list, entries]) => Object.keys(entries)
    .filter((k) => k.startsWith(`${file} > `) && k !== outside)
    .filter((k) => !testNames.some((n) => (k.endsWith(" > *") ? n.startsWith(k.slice(0, -1)) : n === k)))
    .map((k) => `${list}: "${k}"`));
}

/** The exports of spine/stampedImport.ts that write what a node received, each wrapped by test/stampedEndingSetup.ts so the ending records it. */
export const ENDING_WRAPPED = ["applyChangeBundle", "beginJoin", "markJoinDone", "mergeUnitsIntoWorkspace"] as const;

/** Every other function exported by spine/stampedImport.ts, and why the ending need not see it (guards/stampedEndingReach.guard.test.ts: a new export is in one of the
 *  two lists, so a new way in for received data cannot go unrecorded). */
export const ENDING_NOT_RECEIVING: Record<string, string> = {
  joinRefused: "builds the error a refused join throws; writes nothing",
  decideJoin: "reads whether a join may start; writes nothing",
  readJoinRemoval: "reads what a join would remove; writes nothing",
  readJoinProgress: "reads how far a join is; writes nothing",
  applyStampedPage: "writes one page of a join's snapshot, which is not taken until markJoinDone (wrapped) finishes the join; a join cancelled before that leaves nothing taken",
  cancelJoin: "throws away a join that did not finish: nothing received stays",
  admitSyncNode: "records that a node may send (the pairing step): no data of the sender is written",
};

/** One thing the ending found (helpers/stampedEnding.ts). It runs every step on every node and reports each of these; a pinned finding (ENDING_FAILS) takes out
 *  only the ones it describes.
 *  - `stored`: a unit a node stored in a step that must store nothing (the first round after the test said it was quiet, one more round, the full resend); `unit`
 *    null when the take reported more than it named and the stamps that changed on that node in that step do not name it (stampedEnding.ts nameUnnamedStores).
 *  - `row`: a row of a node's own state that the two steps changed without storing anything of that table (`side`: the row as it was, or as it is now).
 *  - `stamp`, `head`, `value`: a stamp, another head, or a unit's value one node holds and another does not; `copyOfCreation`: a field stamp that repeats its row's
 *    creation stamp, which the other node holds. */
export type Difference =
  | { kind: "stored"; step: "claimed quiet" | "one more round" | "full resend"; peer: string; unit: { table: string; row: string; field: string } | null }
  | { kind: "row"; peer: string; table: string; side: "before" | "after"; row: Record<string, unknown> }
  | { kind: "stamp" | "head"; onlyOn: string; other: string; item: Record<string, unknown>; copyOfCreation: boolean }
  | { kind: "value"; onlyOn: string; other: string; label: string; row: string; text: string };
