// The pages branch holds exactly the pushed site (githubPages.mirrorToBranch):
// a takedown deletes files instead of leaving them served, and the branch
// history keeps no earlier site.
import { describe, expect, it } from "vitest";
import { gitBlobSha, mirrorToBranch, type PagesGitClient } from "../modules/website/publishing/githubPages.js";

type Entry = { path: string; sha: string };

function fakeGitHub(branch: Entry[] | null) {
  const log = { uploaded: [] as string[], tree: [] as Entry[], parents: null as string[] | null, ref: "", created: false };
  const notFound = Object.assign(new Error("Not Found"), { status: 404 });
  const unprocessable = Object.assign(new Error("Reference does not exist"), { status: 422 });
  const git: PagesGitClient = {
    getTree: async () => {
      if (!branch) throw notFound;
      return { data: { tree: branch.map((e) => ({ ...e, type: "blob" })) } };
    },
    createBlob: async ({ content }) => {
      const buf = Buffer.from(content, "base64");
      log.uploaded.push(buf.toString("utf8"));
      return { data: { sha: gitBlobSha(buf) } };
    },
    createTree: async ({ tree }) => { log.tree = tree.map(({ path, sha }) => ({ path, sha })); return { data: { sha: "tree1" } }; },
    createCommit: async ({ parents }) => { log.parents = parents; return { data: { sha: "commit1" } }; },
    updateRef: async ({ ref, force }) => {
      if (!branch) throw unprocessable;
      expect(force).toBe(true);
      log.ref = ref;
    },
    createRef: async ({ ref }) => { log.ref = ref; log.created = true; },
  };
  return { git, log };
}

const target = { owner: "o", repo: "r", branch: "gh-pages" };

describe("mirrorToBranch", () => {
  it("replaces the branch with exactly the new files, in one parentless commit", async () => {
    const { git, log } = fakeGitHub([
      { path: "index.html", sha: gitBlobSha("<html>") },
      { path: "media/taken-down.webp", sha: gitBlobSha("secret") },
    ]);
    await mirrorToBranch(git, target, [
      { path: "index.html", content: "<html>" },
      { path: "site.json", content: "{}" },
      { path: "media/kept.webp", content: Buffer.from([0xde, 0xad]) },
    ], "Publish");

    expect(log.tree.map((e) => e.path)).toEqual(["index.html", "media/kept.webp", "site.json"]);
    expect(log.parents).toEqual([]);
    expect(log.ref).toBe("heads/gh-pages");
    // An unchanged file is reused by id, not uploaded again.
    expect(log.uploaded).not.toContain("<html>");
    expect(log.uploaded).toContain("{}");
    expect(log.tree.find((e) => e.path === "media/kept.webp")!.sha).toBe(gitBlobSha(Buffer.from([0xde, 0xad])));
  });

  it("creates the branch on the first push", async () => {
    const { git, log } = fakeGitHub(null);
    await mirrorToBranch(git, target, [{ path: "index.html", content: "<html>" }], "Publish");
    expect(log.created).toBe(true);
    expect(log.ref).toBe("refs/heads/gh-pages");
    expect(log.uploaded).toEqual(["<html>"]);
  });

  it("gitBlobSha matches git's blob id", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});
