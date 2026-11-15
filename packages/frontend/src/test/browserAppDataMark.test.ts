// The trial's "this browser had notes before" mark (lib/browserAppDataMark.ts): either of its two places is enough,
// and a mark that was never made, or that "Start over" took away, reports nothing.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { forgetNotesMark, markNotesKept, notesWereLost } from "../lib/browserAppDataMark";

const wipeIndexedDb = async () => { for (const db of (await indexedDB.databases?.()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name); };

beforeEach(async () => {
  localStorage.clear();
  await wipeIndexedDb();
});

describe("the mark that this browser kept notes", () => {
  it("is absent before a copy was ever saved, and asking does not make it", async () => {
    expect(await notesWereLost()).toBe(false);
    expect(await notesWereLost()).toBe(false);
    expect((await indexedDB.databases()).map((db) => db.name)).not.toContain("onden-trial-mark");
  });

  it("is there once a copy was saved, in both places", async () => {
    await markNotesKept();
    expect(await notesWereLost()).toBe(true);
    expect((await indexedDB.databases()).map((db) => db.name)).toContain("onden-trial-mark");
    expect(Object.keys(localStorage).some((key) => key.includes("hadNotes"))).toBe(true);
  });

  it("survives losing either place alone (clearing the notes' own storage is not one of them)", async () => {
    await markNotesKept();
    localStorage.clear();
    expect(await notesWereLost()).toBe(true); // the database mark
    await markNotesKept();
    await wipeIndexedDb();
    expect(await notesWereLost()).toBe(true); // the localStorage mark
  });

  it("is gone with everything (clearing all site data is the case this cannot see)", async () => {
    await markNotesKept();
    localStorage.clear();
    await wipeIndexedDb();
    expect(await notesWereLost()).toBe(false);
  });

  it("is taken away by Start over, so the person's own erase is not reported as a loss", async () => {
    await markNotesKept();
    await forgetNotesMark();
    await new Promise((resolve) => setTimeout(resolve, 20)); // deleteDatabase finishes on its own
    expect(await notesWereLost()).toBe(false);
  });
});
