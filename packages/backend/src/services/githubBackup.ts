// Per-note backup-to-GitHub sync. Pushes a single markdown file to a
// configured backup repository on every save, so the repo serves as both
// a plain-text disaster-recovery backup AND a GitHub Actions trigger
// surface (users can wire actions to sync, lint, publish-derivatives,
// notify, etc.).
//
// Companion to writeAndCommit() in git.ts:
//   - writeAndCommit writes + commits to the LOCAL container git repo
//     (content_data named volume). Lives or dies with the container/volume.
//   - pushNoteToBackup pushes the SAME content to a REMOTE GitHub repo
//     via the HTTP API. Survives container loss; triggers Actions.
//
// Reference / shape: mirrors modules/website/publishing/githubPages.ts which
// uses the same Octokit + CreateOrUpdateFiles pattern for the publish
// flow. Two separate env-var sets (PAGES vs BACKUP) so users can target
// different repos.
//
// Not part of modules/website/publishing/: it backs up every save, published or
// not, and the outbox performs it while publishing enqueues through the
// outbox — inside publishing it would put the two on an import cycle.
//
// NOT fire-and-forget any more. This effect is enqueued in the transactional
// outbox (migration 046) and performed by the retrying reconciler
// (services/outbox.ts → performEffect). For that reconciler to surface and
// retry failures, this function MUST THROW on a genuine push failure — a
// thrown error is what the outbox catches to bump attempts / dead-letter the
// row with `last_error`. It returns null ONLY for the benign "nothing to do"
// cases (no remote configured, malformed GITHUB_BACKUP_REPO), which the
// reconciler treats as success. Swallowing a real API error here would let a
// failed backup be silently marked `done` with no record — the exact
// data-safety hole the outbox was built to close ([[restore-state]]).
//
// Memory: project_git_retire_roadmap (superseded — see new direction
// in commit message). Phase 1 retire was reverted; instead this file
// adds the remote-push leg per the Wiki.js two-track backup model.

import { Octokit } from "@octokit/rest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — package ships no types, plugin returns runtime methods on the Octokit instance
import { CreateOrUpdateFiles } from "octokit-commit-multiple-files";
import { log } from "../logger.js";
import { config } from "../config.js";
import { isUuid } from "@onden/markdown";

// The `octokit-commit-multiple-files` plugin attaches createOrUpdateFiles() to
// the Octokit instance at runtime but ships no types. This is the slice of its
// API we use — cast `octokit as unknown as CreateOrUpdateFilesClient` instead of
// reaching for `any`.
export interface CreateOrUpdateFilesClient {
  createOrUpdateFiles(args: {
    owner: string;
    repo: string;
    branch: string;
    createBranch?: boolean;
    changes: Array<{ message: string; files: Record<string, string | Buffer> }>;
  }): Promise<{ data?: { commit?: { sha?: string } } }>;
}

const OctokitWithFiles = Octokit.plugin(CreateOrUpdateFiles);

// Single shared Octokit + cached clients per (token, repo) pair. Building
// a new client on every save costs ~ms and leaks event-loop listeners on
// hot save loops.
const clientCache = new Map<string, Octokit>();
function getOctokit(token: string): Octokit {
  let client = clientCache.get(token);
  if (!client) {
    client = new OctokitWithFiles({ auth: token, userAgent: "onden-backup/1.0" });
    clientCache.set(token, client);
  }
  return client;
}

type BackupResult = {
  url: string;             // commit URL on github
  branch: string;
  filePath: string;
};

/**
 * Push a single note's markdown to the configured backup repo.
 *
 * @param slug    Node slug, used as the file basename (`<slug>.md`).
 * @param content Markdown body to write.
 * @param message Commit message (callers pass NODE_CREATED / NODE_UPDATED / IMPORT).
 *
 * Returns null when the env vars aren't set (no remote target — silently
 * skip, consistent with how writeAndCommit handles a missing content/ dir).
 * Returns BackupResult on a successful API push.
 * THROWS on a genuine API failure so the outbox reconciler retries it and,
 * after max_attempts, dead-letters the row with the error in `last_error`
 * (surfaced in the UI) — backup failures are never silently dropped.
 *
 * Env vars:
 *   GITHUB_BACKUP_TOKEN       — PAT with contents:write on the backup repo
 *                               (falls back to GITHUB_TOKEN if unset)
 *   GITHUB_BACKUP_REPO        — "owner/repo" of the backup repository
 *   GITHUB_BACKUP_BRANCH      — branch name (default: "main")
 *   GITHUB_BACKUP_PATH_PREFIX — path prefix inside the repo (default: "notes/")
 *
 * Token separation: prefer a backup-scoped PAT (least-privilege: write on only
 * the backup repo) over the shared GITHUB_TOKEN, so a leak of one token doesn't
 * also expose the pages repo. A single GITHUB_TOKEN still works for simple
 * setups where both flows share one PAT.
 */
export async function pushNoteToBackup(
  // Relative to the repo prefix: `<slug>.md` or `<space-id>/<slug>.md`
  // (services/outbox.ts backupTarget).
  path: string,
  content: string,
  message: string,
  // Test seam: inject a client to drive the success/failure paths without
  // real network I/O. Production passes nothing — a cached real Octokit is used.
  injectedClient?: CreateOrUpdateFilesClient,
): Promise<BackupResult | null> {
  const token = config.str("GITHUB_BACKUP_TOKEN") ?? config.str("GITHUB_TOKEN");
  const repo = config.str("GITHUB_BACKUP_REPO");
  const branch = config.str("GITHUB_BACKUP_BRANCH") ?? "main";
  const prefix = config.str("GITHUB_BACKUP_PATH_PREFIX") ?? "notes/";
  if (!token || !repo) return null;

  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    log.error("backup", "GITHUB_BACKUP_REPO must be in 'owner/repo' format", { repo });
    return null;
  }

  // Sanitise the path — strip traversal attempts and odd characters, defensive
  // since a path-traversal here could overwrite repo files. At most one folder,
  // and only a space id (backupTarget's `<space-id>/<slug>.md`); anything else
  // is flattened. Letters of any script stay (slugify keeps them): an
  // ASCII-only rule turned every Chinese title into underscores, so those
  // notes overwrote one another's file.
  const segments = path.replace(/\.md$/, "").split("/");
  const folder = segments.length === 2 && isUuid(segments[0]!) ? `${segments[0]}/` : "";
  const name = (folder ? segments[1]! : segments.join("/")).replace(/[^\p{L}\p{N}_-]/gu, "_");
  const filePath = `${prefix}${folder}${name}.md`;

  const octokit = injectedClient ?? (getOctokit(token) as unknown as CreateOrUpdateFilesClient);

  try {
    const result = await octokit.createOrUpdateFiles({
      owner,
      repo: repoName,
      branch,
      createBranch: true,
      changes: [
        {
          message,
          files: { [filePath]: content },
        },
      ],
    });
    // The plugin returns the commit object; URL shape:
    //   https://github.com/{owner}/{repo}/commit/{sha}
    // We construct it explicitly because the plugin's response shape
    // varies across versions.
    const sha = result?.data?.commit?.sha;
    const url = sha
      ? `https://github.com/${owner}/${repoName}/commit/${sha}`
      : `https://github.com/${owner}/${repoName}/tree/${branch}/${filePath}`;
    return { url, branch, filePath };
  } catch (err) {
    // Re-throw so the outbox reconciler (services/outbox.ts) catches it and
    // retries with backoff, then dead-letters with `last_error` after
    // max_attempts. The user's DB save already committed independently in an
    // EARLIER transaction (the outbox intent was enqueued atomically with it),
    // so throwing here can NOT roll back the save — it only drives the durable
    // retry/surface machinery. Swallowing the error would silently mark the
    // backup `done`, the data-loss footgun this fix closes.
    const detail = err instanceof Error ? err.message : String(err);
    log.error("backup", `push failed for ${filePath}`, { err });
    throw new Error(`github backup push failed for ${filePath}: ${detail}`);
  }
}
