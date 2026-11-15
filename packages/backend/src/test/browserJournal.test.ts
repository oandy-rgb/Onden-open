// The browser app's write-ahead log and its schema rule (src/browser/journal.ts, schemaCheck.ts), against a fake IndexedDB.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { isJournaled, openJournal } from "../browser/journal.js";
import { judgeSchema } from "../browser/schemaCheck.js";

const request = (path: string) => ({ method: "POST", path, headers: [["content-type", "application/json"]] as Array<[string, string]>, body: new TextEncoder().encode("{}").buffer as ArrayBuffer });

beforeEach(async () => { await (await openJournal())!.clear(); });

describe("journal", () => {
  it("keeps entries in order and returns the ones after a number", async () => {
    const journal = (await openJournal())!;
    const a = await journal.append(request("/api/a"));
    const b = await journal.append(request("/api/b"));
    const c = await journal.append(request("/api/c"));
    expect([a, b, c]).toEqual([a, a + 1, a + 2]);
    expect((await journal.after(a)).map((e) => e.path)).toEqual(["/api/b", "/api/c"]);
    expect(await journal.lastSeq()).toBe(c);
  });

  it("trimming removes what a copy already holds and keeps the rest", async () => {
    const journal = (await openJournal())!;
    const a = await journal.append(request("/api/a"));
    const b = await journal.append(request("/api/b"));
    await journal.trimThrough(a);
    expect((await journal.after(0)).map((e) => e.seq)).toEqual([b]);
  });

  it("numbers stay above the loaded copy even when the log is empty, so a new entry is never mistaken for an old one", async () => {
    const journal = (await openJournal())!;
    await journal.clear();
    const fresh = (await openJournal())!; // a new start: nothing in the log, the copy says it holds up to 57
    fresh.startAfter(57);
    const seq = await fresh.append(request("/api/new"));
    expect(seq).toBeGreaterThan(57);
    expect((await fresh.after(57)).map((e) => e.path)).toEqual(["/api/new"]);
  });

  it("an entry survives opening the database again (the page was reloaded)", async () => {
    const first = (await openJournal())!;
    const seq = await first.append(request("/api/kept"));
    const second = (await openJournal())!;
    const [entry] = await second.after(seq - 1);
    expect(entry.path).toBe("/api/kept");
    expect(new TextDecoder().decode(entry.body!)).toBe("{}");
  });

  it("logs writes, not reads, and not the worker's own or sign-in requests", () => {
    expect(isJournaled("POST", "/api/nodes")).toBe(true);
    expect(isJournaled("patch", "/api/nodes/1?x=1")).toBe(true);
    expect(isJournaled("DELETE", "/api/nodes/1")).toBe(true);
    expect(isJournaled("GET", "/api/nodes")).toBe(false);
    expect(isJournaled("POST", "/api/browser-app/clear-samples")).toBe(false);
    expect(isJournaled("POST", "/api/auth/sign-in/email")).toBe(false);
    expect(isJournaled("POST", "/api/backup/restore/upload")).toBe(false);
    expect(isJournaled("POST", "/api/media")).toBe(false); // the file is already stored when the upload is answered; a replay would store it twice
    expect(isJournaled("POST", "/api/backup/restore/abc/apply")).toBe(false);
    // POST /api/sync only reads (routes/sync.ts). Logged, it was never trimmed (no change → no copy), so every reopen
    // replayed it, reported "recovered 1" and saved a whole copy for nothing.
    expect(isJournaled("POST", "/api/sync")).toBe(false);
    expect(isJournaled("POST", "/api/sync/bodies")).toBe(false);
  });
});

describe("schema rule", () => {
  const bundled = ["001_a", "002_b", "003_c"];
  it("same migrations: nothing to do", () => expect(judgeSchema(bundled, bundled)).toEqual({ kind: "current" }));
  it("fewer migrations: upgrade, naming the ones to run", () => expect(judgeSchema(["001_a"], bundled)).toEqual({ kind: "upgrade", pending: ["002_b", "003_c"] }));
  it("a migration this build does not know: the copy is newer, refuse", () => expect(judgeSchema([...bundled, "004_future"], bundled)).toEqual({ kind: "newer", unknown: ["004_future"] }));
  it("a copy with no migrations at all is an upgrade of everything (a brand new database)", () => expect(judgeSchema([], bundled).kind).toBe("upgrade"));
});
