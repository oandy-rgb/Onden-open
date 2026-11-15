// GitHub Pages deployment.
//
// Pushes a set of files to a configured GitHub repo's pages branch
// (mirrorToBranch: the branch becomes exactly those files). Returns the public
// Pages URL on success; null when the env vars aren't configured (callers
// treat that as "no remote target, skip deploy step").

import { compareText } from "@onden/markdown";
import { createHash } from "node:crypto";
import { sep } from "node:path";
import { Octokit } from "@octokit/rest";
import { config } from "../../../config.js";

// One file in a deployed bundle. Text assets (html/js/css/json) carry their
// content as a utf8 string; binary assets (copied media blobs) carry a Buffer,
// uploaded base64 verbatim (no lossy utf8 round-trip).
export type BundleFile = { path: string; content: string | Buffer };

// The public URL the pages repo will serve at, derived from config without any
// network call. Lets the publish route record an artifact_ref synchronously even
// though the actual push now happens asynchronously via the outbox. Returns null
// when no pages repo is configured.
export function expectedPagesUrl(): string | null {
  const repo = config.str("GITHUB_PAGES_REPO");
  if (!repo) return null;
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) return null;
  return `https://${owner}.github.io/${repoName}/`;
}

// The few git-data calls a push makes (Octokit's rest.git.*), so a test can
// stand in for GitHub.
export type PagesGitClient = {
  getTree(p: { owner: string; repo: string; tree_sha: string; recursive?: string }): Promise<{ data: { tree: Array<{ path?: string; type?: string; sha?: string }>; truncated?: boolean } }>;
  createBlob(p: { owner: string; repo: string; content: string; encoding: "base64" }): Promise<{ data: { sha: string } }>;
  createTree(p: { owner: string; repo: string; tree: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> }): Promise<{ data: { sha: string } }>;
  createCommit(p: { owner: string; repo: string; message: string; tree: string; parents: string[] }): Promise<{ data: { sha: string } }>;
  updateRef(p: { owner: string; repo: string; ref: string; sha: string; force: boolean }): Promise<unknown>;
  createRef(p: { owner: string; repo: string; ref: string; sha: string }): Promise<unknown>;
};

/** The git blob id GitHub would give `content`, so an unchanged file is not
 *  uploaded again. */
export function gitBlobSha(content: string | Buffer): string {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

/**
 * Make the pages branch hold exactly `files`, as one commit with no parent,
 * force-moved onto the branch.
 *
 * - A file the site no longer has is gone from the branch, not left behind: a
 *   taken-down note's images used to stay served from media/ for good.
 * - No parent: the branch history does not keep earlier site.json or media
 *   either. GitHub may still answer an old commit by its id for a while, and
 *   forks or clones keep what they fetched; that is outside Onden's reach.
 * - The branch belongs to Onden: anything added to it by hand is removed by
 *   the next push (docs/agents/deploy.md).
 */
export async function mirrorToBranch(
  git: PagesGitClient,
  target: { owner: string; repo: string; branch: string },
  files: BundleFile[],
  message: string,
): Promise<void> {
  const { owner, repo, branch } = target;
  // Blobs the branch already has are reused by id instead of uploaded again.
  const existing = new Set<string>();
  try {
    const { data } = await git.getTree({ owner, repo, tree_sha: branch, recursive: "1" });
    for (const e of data.tree) if (e.type === "blob" && e.sha) existing.add(e.sha);
  } catch (e) {
    if (!isNotFound(e)) throw e; // no branch yet: everything is uploaded
  }
  const entries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  const queue = [...files];
  const upload = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      let sha = gitBlobSha(f.content);
      if (!existing.has(sha)) {
        const content = typeof f.content === "string" ? Buffer.from(f.content, "utf8") : f.content;
        sha = (await git.createBlob({ owner, repo, content: content.toString("base64"), encoding: "base64" })).data.sha;
      }
      entries.push({ path: f.path.split(sep).join("/"), mode: "100644", type: "blob", sha });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, upload));
  entries.sort((a, b) => compareText(a.path, b.path));

  const tree = (await git.createTree({ owner, repo, tree: entries })).data.sha;
  const commit = (await git.createCommit({ owner, repo, message, tree, parents: [] })).data.sha;
  try {
    await git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit, force: true });
  } catch (e) {
    if (!isNotFound(e) && !isUnprocessable(e)) throw e;
    await git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit });
  }
}

const statusOf = (e: unknown) => (e as { status?: number } | null)?.status;
const isNotFound = (e: unknown) => statusOf(e) === 404 || statusOf(e) === 409; // 409: empty repository
const isUnprocessable = (e: unknown) => statusOf(e) === 422; // updateRef on a missing branch

export async function pushToGitHubPages(
  files: BundleFile[],
): Promise<string | null> {
  // Prefer a pages-scoped PAT so it can be least-privilege (write on only the
  // pages repo); fall back to the shared GITHUB_TOKEN for single-token setups.
  const token = config.str("GITHUB_PAGES_TOKEN") ?? config.str("GITHUB_TOKEN");
  const repo = config.str("GITHUB_PAGES_REPO"); // "owner/repo"
  const branch = config.str("GITHUB_PAGES_BRANCH") ?? "gh-pages";
  if (!token || !repo) return null;

  const [owner, repoName] = repo.split("/");
  const octokit = new Octokit({ auth: token, userAgent: "onden-publish/1.0" });
  await mirrorToBranch(
    octokit.rest.git as unknown as PagesGitClient,
    { owner, repo: repoName, branch },
    files,
    `Publish site [${new Date().toISOString()}]`,
  );
  return `https://${owner}.github.io/${repoName}/`;
}
