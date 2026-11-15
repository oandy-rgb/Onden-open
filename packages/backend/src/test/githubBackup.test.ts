// GitHub backup error-surfacing guard ([[restore-state]] data-safety).
//
// The remote GitHub backup is enqueued in the transactional outbox (migration
// 046) and performed by the retrying reconciler. For a failed backup to be
// SURFACED (retried, then dead-lettered with `last_error`) rather than silently
// lost, pushNoteToBackup MUST THROW on a genuine API failure — the outbox only
// catches throws to bump attempts. This file pins three properties so a future
// "don't let backup break anything" tweak can't silently reopen the hole that
// the fire-and-forget `.catch(() => null)` chain used to be:
//
//   1. a real API failure THROWS (so the outbox retries / dead-letters it);
//   2. "no remote configured" returns null (benign skip, treated as success);
//   3. a successful push returns the commit URL (the backup round-trips).
//
// No network, no DB — the Octokit client is injected via the test seam.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pushNoteToBackup } from "../services/githubBackup.js";
import type { CreateOrUpdateFilesClient } from "../modules/website/publishing/types.js";

const ENV_KEYS = [
  "GITHUB_BACKUP_TOKEN", "GITHUB_TOKEN", "GITHUB_BACKUP_REPO",
  "GITHUB_BACKUP_BRANCH", "GITHUB_BACKUP_PATH_PREFIX",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function client(impl: CreateOrUpdateFilesClient["createOrUpdateFiles"]): CreateOrUpdateFilesClient {
  return { createOrUpdateFiles: impl };
}

describe("pushNoteToBackup — failures are surfaced, not swallowed", () => {
  it("THROWS when the GitHub API call fails (so the outbox retries/dead-letters it)", async () => {
    process.env.GITHUB_BACKUP_TOKEN = "tok";
    process.env.GITHUB_BACKUP_REPO = "owner/repo";
    const boom = client(async () => { throw new Error("403 rate limited"); });
    await expect(pushNoteToBackup("my-note", "# hi", "NODE_UPDATED", boom))
      .rejects.toThrow(/github backup push failed/);
    // and the original cause is preserved for `last_error` surfacing
    await expect(pushNoteToBackup("my-note", "# hi", "NODE_UPDATED", boom))
      .rejects.toThrow(/403 rate limited/);
  });

  it("returns null (benign skip) when no remote is configured — never throws", async () => {
    // token + repo both unset → nothing to do; must NOT throw (would dead-letter
    // every save on an instance that never configured a backup repo).
    const neverCalled = client(async () => { throw new Error("should not be called"); });
    await expect(pushNoteToBackup("my-note", "# hi", "NODE_UPDATED", neverCalled))
      .resolves.toBeNull();
  });

  it("returns null on a malformed GITHUB_BACKUP_REPO (not 'owner/repo')", async () => {
    process.env.GITHUB_BACKUP_TOKEN = "tok";
    process.env.GITHUB_BACKUP_REPO = "no-slash";
    const neverCalled = client(async () => { throw new Error("should not be called"); });
    await expect(pushNoteToBackup("my-note", "# hi", "NODE_UPDATED", neverCalled))
      .resolves.toBeNull();
  });

  it("round-trips: a successful push returns the commit URL + path", async () => {
    process.env.GITHUB_BACKUP_TOKEN = "tok";
    process.env.GITHUB_BACKUP_REPO = "owner/repo";
    let captured: { owner: string; repo: string; branch: string; files: Record<string, string | Buffer> } | null = null;
    const ok = client(async (args) => {
      captured = {
        owner: args.owner, repo: args.repo, branch: args.branch,
        files: args.changes[0].files,
      };
      return { data: { commit: { sha: "abc123" } } };
    });
    const res = await pushNoteToBackup("my-note", "# hello", "NODE_CREATED", ok);
    expect(res).not.toBeNull();
    expect(res!.url).toBe("https://github.com/owner/repo/commit/abc123");
    expect(res!.branch).toBe("main");
    expect(res!.filePath).toBe("notes/my-note.md");
    // the content actually round-trips to the API call
    expect(captured!.files["notes/my-note.md"]).toBe("# hello");
    expect(captured!.owner).toBe("owner");
    expect(captured!.repo).toBe("repo");
  });

  it("sanitises a path-traversal slug before it reaches the repo path", async () => {
    process.env.GITHUB_BACKUP_TOKEN = "tok";
    process.env.GITHUB_BACKUP_REPO = "owner/repo";
    let path = "";
    const ok = client(async (args) => {
      path = Object.keys(args.changes[0].files)[0];
      return { data: { commit: { sha: "deadbeef" } } };
    });
    await pushNoteToBackup("../../etc/passwd", "x", "NODE_UPDATED", ok);
    expect(path).toBe("notes/______etc_passwd.md");
    expect(path).not.toContain("..");
  });

  it("keeps letters of any script and one space-id folder; anything else is flattened", async () => {
    process.env.GITHUB_BACKUP_TOKEN = "tok";
    process.env.GITHUB_BACKUP_REPO = "owner/repo";
    const paths: string[] = [];
    const ok = client(async (args) => {
      paths.push(Object.keys(args.changes[0].files)[0]);
      return { data: { commit: { sha: "deadbeef" } } };
    });
    const space = "0b5f4e3c-1d2a-4b6c-8e9f-a1b2c3d4e5f6";
    await pushNoteToBackup("論文筆記.md", "x", "NODE_UPDATED", ok);
    await pushNoteToBackup("論文筆記-2.md", "x", "NODE_UPDATED", ok);
    await pushNoteToBackup(`${space}/日記.md`, "x", "NODE_UPDATED", ok);
    await pushNoteToBackup("a/b/c.md", "x", "NODE_UPDATED", ok);
    expect(paths).toEqual(["notes/論文筆記.md", "notes/論文筆記-2.md", `notes/${space}/日記.md`, "notes/a_b_c.md"]);
  });
});
