// A process that dies between `git add` and `git commit` leaves
// .git/index.lock behind; every later backup commit then failed until someone
// deleted it by hand (W27). writeAndCommit clears a lock once it is stale —
// older than any live outbox attempt can be — and leaves a fresh one alone.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "onden-git-"));
vi.spyOn(process, "cwd").mockReturnValue(root);
const { initGit, writeAndCommit, STORE, STALE_INDEX_LOCK_MS } = await import("../git.js");
const lock = () => join(STORE, ".git", "index.lock");

describe("git backup commit and a leftover index.lock", () => {
  beforeAll(async () => { await initGit(); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("removes a stale lock and commits", async () => {
    writeFileSync(lock(), "");
    const old = (Date.now() - STALE_INDEX_LOCK_MS - 60_000) / 1000;
    utimesSync(lock(), old, old);
    expect(await writeAndCommit("a.md", "# A", "save a")).toBeTruthy();
    expect(existsSync(lock())).toBe(false);
  });

  it("leaves a fresh lock alone (a live writer may hold it)", async () => {
    writeFileSync(lock(), "");
    await expect(writeAndCommit("b.md", "# B", "save b")).rejects.toThrow(/index\.lock/);
    expect(existsSync(lock())).toBe(true);
  });
});
