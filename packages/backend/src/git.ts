import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, normalize } from "path";
import { simpleGit } from "simple-git";

export const STORE = join(process.cwd(), "content");

export async function initGit() {
  mkdirSync(STORE, { recursive: true });
  const git = simpleGit(STORE);
  if (!existsSync(join(STORE, ".git"))) {
    await git.init();
    await git.addConfig("user.name", "Onden");
    await git.addConfig("user.email", "onden@local");
  }
}

function g(signal?: AbortSignal) {
  return simpleGit({ baseDir: STORE, ...(signal ? { abort: signal } : {}) });
}

/** A lock older than this has no live writer: every commit runs inside one
 *  outbox attempt, which is aborted at its timeout (EFFECT_TIMEOUT_MS, 60s). */
export const STALE_INDEX_LOCK_MS = 5 * 60_000;

/** A process that died between `add` and `commit` leaves `.git/index.lock`
 *  behind, and every later commit then fails. Remove it once it is stale. */
function clearStaleIndexLock(now = Date.now()): boolean {
  const lock = join(STORE, ".git", "index.lock");
  try {
    if (now - statSync(lock).mtimeMs < STALE_INDEX_LOCK_MS) return false;
    unlinkSync(lock);
    return true;
  } catch {
    return false; // no lock (or it vanished meanwhile)
  }
}

/** Write a note's backup at `path` (relative to the store, e.g. `<slug>.md` or
 *  `<space-id>/<slug>.md`; services/outbox.ts backupTarget) and commit it.
 *  Returns the commit hash, or null when nothing changed. */
export async function writeAndCommit(path: string, markdown: string, message: string, signal?: AbortSignal): Promise<string | null> {
  const filename = normalize(path);
  if (filename.startsWith("..") || filename.startsWith("/")) throw new Error(`backup path escapes the store: ${path}`);
  mkdirSync(dirname(join(STORE, filename)), { recursive: true });
  writeFileSync(join(STORE, filename), markdown, "utf-8");
  clearStaleIndexLock();
  const git = g(signal);
  await git.add(filename);
  const status = await git.status();
  if (status.staged.length === 0) return null;
  const result = await git.commit(message);
  return result.commit || null;
}

/** A commit id as git prints it. Anything else reaching `git show` could be
 *  read as an option (`--output=<file>` writes a file). */
const COMMIT_HASH = /^[0-9a-f]{7,64}$/;

export async function getDiff(hash: string): Promise<string> {
  if (!COMMIT_HASH.test(hash)) return "";
  try {
    return await g().show([hash]);
  } catch {
    return "";
  }
}
