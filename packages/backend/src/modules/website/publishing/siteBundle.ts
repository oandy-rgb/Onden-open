// The stored static copy of the served site: made once, then reused by the zip
// download (GET /api/export-static), the GitHub Pages push (pagesPush.ts) and
// the live site's search (GET /api/site/search.idx/*).
//
// Content only changes when the owner publishes, or when a takedown changes
// "the latest snapshot minus takedowns" (servedSite.ts), so crawling the
// frontend on every download would repeat the same work. A copy is therefore
// made when the served site changes (the site_bundle outbox effect, queued next
// to every pages_push) and keyed by what it was made from:
//
//   key = hash(format, frontend build, servedSiteVersion: the snapshot and the served payload)
//
// The served payload is already the snapshot minus takedowns, so a takedown
// changes the key and a copy made before it can never answer for the site now.
// Whoever asks (a zip, a push) computes the current key first and builds the
// copy only if none is stored — the first run after a deploy, or a request that
// beats the queued job; concurrent askers share one build.
//
// On disk, under <content store>/site-bundles:
//   <key>/tree/…         the copy (what the zip and the push hold, search index included)
//   <key>/manifest.json  what retargetStaticSite needs; written last
//   .tmp-<key>-<rand>/   a copy being made; renamed to <key> in one step, so a
//                        reader sees a whole copy or none, never a partial one
// Only the newest KEEP copies stay; the rest and abandoned .tmp- folders go.
// The store is a cache: deleting it only costs a rebuild, so backups skip it.

import { compareText } from "@onden/markdown";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "../../../utils.js";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { STORE } from "../../../git.js";
import type { BundleFile } from "./githubPages.js";
import { loadServedSite, servedSiteVersion } from "./servedSite.js";
import { indexStaticSite } from "./siteSearchIndex.js";
import {
  buildStaticSite, SEARCH_INDEX_DIR, StaticSiteUnavailable, type StaticSite, type StaticSiteFacts, type StaticSiteOptions,
} from "./staticSite.js";
import { log } from "../../../logger.js";
import { config } from "../../../config.js";

/** Bump when the files a copy holds change shape, so copies made by older code are rebuilt. */
const BUNDLE_FORMAT = 2;
/** Newest copies kept: the current one and the one a download may still be reading. */
const KEEP = 2;
const ABANDONED_TMP_MS = 60 * 60_000;
/** A copy is rebuilt when the served site changes under it; give up after this many tries. */
const BUILD_ATTEMPTS = 3;

export const BUNDLE_ROOT = join(STORE, "site-bundles");

export type StoredBundle = {
  key: string;
  /** Folder holding the copy's files. */
  tree: string;
  facts: StaticSiteFacts;
};

type Manifest = { key: string; builtAt: string; facts: StaticSiteFacts };

/** What a copy is made from now. The frontend build is part of it: a deploy
 *  changes the pages' CSS and scripts, and the copy must carry the new ones. */
export async function currentBundleKey(workspaceId: string): Promise<string> {
  const site = await loadServedSite(workspaceId);
  return sha256Hex(JSON.stringify([BUNDLE_FORMAT, config.str("ONDEN_BUILD_ID") ?? "", servedSiteVersion(site)])).slice(0, 32);
}

const KEY = /^[0-9a-f]{32}$/;

async function openBundle(root: string, key: string): Promise<StoredBundle | null> {
  if (!KEY.test(key)) return null;
  try {
    const manifest = JSON.parse(await readFile(join(root, key, "manifest.json"), "utf8")) as Manifest;
    return { key, tree: join(root, key, "tree"), facts: manifest.facts };
  } catch {
    return null;
  }
}

export type BundleOptions = StaticSiteOptions & {
  /** Where copies are kept; tests use a temporary folder. */
  root?: string;
};

const inflight = new Map<string, Promise<StoredBundle>>();

/** The stored copy of the served site as it is now, made first if there is
 *  none. Everything that needs the static output asks here. */
export async function ensureSiteBundle(opts: BundleOptions): Promise<StoredBundle> {
  const root = opts.root ?? BUNDLE_ROOT;
  const key = await currentBundleKey(opts.workspaceId);
  const stored = await openBundle(root, key);
  if (stored) return stored;
  const pending = inflight.get(`${root}:${key}`);
  if (pending) return pending;
  const job = makeBundle(opts, root, key).finally(() => inflight.delete(`${root}:${key}`));
  inflight.set(`${root}:${key}`, job);
  return job;
}

/** The stored copy of the served site as it is now, or null. Never builds one
 *  in the caller's request (the live site's search must not wait on a crawl):
 *  a missing copy is started in the background for the next request. */
export async function storedSiteBundle(opts: BundleOptions): Promise<StoredBundle | null> {
  const root = opts.root ?? BUNDLE_ROOT;
  const stored = await openBundle(root, await currentBundleKey(opts.workspaceId));
  if (stored) return stored;
  void ensureSiteBundle(opts).catch((e) => {
    log.warn("site-bundle", "background build failed", { err: e });
  });
  return null;
}

async function makeBundle(opts: BundleOptions, root: string, key: string): Promise<StoredBundle> {
  await mkdir(root, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const work = join(root, `.tmp-${key}-${randomBytes(4).toString("hex")}`);
    try {
      const site = await buildStaticSite(opts);
      await writeTree(join(work, "tree"), site);
      await indexStaticSite(join(work, "tree"));
      // Served site changed while the pages were being fetched: the files may
      // mix two states, so this copy is not stored under either key.
      if ((await currentBundleKey(opts.workspaceId)) !== key) {
        if (attempt >= BUILD_ATTEMPTS) throw new StaticSiteUnavailable("the site kept changing while its static copy was made");
        key = await currentBundleKey(opts.workspaceId);
        const stored = await openBundle(root, key);
        if (stored) return stored;
        continue;
      }
      const manifest: Manifest = { key, builtAt: new Date().toISOString(), facts: site.facts };
      await writeFile(join(work, "manifest.json"), JSON.stringify(manifest));
      try {
        await rename(work, join(root, key)); // one step: the copy appears whole
      } catch (e) {
        const stored = await openBundle(root, key); // another process made it first
        if (!stored) throw e;
      }
      await prune(root, key);
      return (await openBundle(root, key))!;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}

async function writeTree(tree: string, site: StaticSite): Promise<void> {
  const base = resolve(tree);
  for (const file of site.files) {
    const target = resolve(base, file.path);
    if (!target.startsWith(base + sep)) throw new Error(`static copy file escapes its folder: ${file.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

/** Keep the current copy and the newest others up to KEEP; drop the rest and
 *  any copy-in-progress folder nobody is writing to any more. */
async function prune(root: string, current: string): Promise<void> {
  const copies: Array<{ name: string; at: number }> = [];
  for (const name of await readdir(root)) {
    const at = (await stat(join(root, name)).catch(() => null))?.mtimeMs;
    if (at === undefined) continue;
    if (name.startsWith(".tmp-")) {
      if (Date.now() - at > ABANDONED_TMP_MS) await rm(join(root, name), { recursive: true, force: true });
    } else if (KEY.test(name)) {
      copies.push({ name, at });
    }
  }
  copies.sort((a, b) => (a.name === current ? -1 : b.name === current ? 1 : b.at - a.at));
  for (const old of copies.slice(KEEP)) await rm(join(root, old.name), { recursive: true, force: true });
}

const TEXT_FILE = /\.(?:html|xml|txt)$/;

/** Every file of a stored copy with its size, found without reading any of them. */
async function bundleEntries(bundle: StoredBundle): Promise<Array<{ path: string; abs: string; bytes: number }>> {
  const entries: Array<{ path: string; abs: string; bytes: number }> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs, path);
      else entries.push({ path, abs, bytes: (await stat(abs)).size });
    }
  };
  await walk(bundle.tree, "");
  return entries.sort((a, b) => compareText(a.path, b.path));
}

/** The path and size of every file of a stored copy (nothing is read). */
export async function bundleFileSizes(bundle: StoredBundle): Promise<Array<{ path: string; bytes: number }>> {
  return (await bundleEntries(bundle)).map(({ path, bytes }) => ({ path, bytes }));
}

/** Every file of a stored copy as a BundleFile (the Pages push and the tests
 *  take these). Pages and feeds come back as text so they can be retargeted.
 *  A file `skip` names is not read at all, so a push can leave a big file out
 *  without ever holding it in memory. */
export async function readBundleFiles(bundle: StoredBundle, skip?: (path: string) => boolean): Promise<BundleFile[]> {
  const files: BundleFile[] = [];
  for (const { path, abs } of await bundleEntries(bundle)) {
    if (skip?.(path)) continue;
    const bytes = await readFile(abs);
    files.push({ path, content: TEXT_FILE.test(path) ? bytes.toString("utf8") : bytes });
  }
  return files;
}

const SEARCH_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** One file of the stored copy's search index, for the live site: `name` is
 *  the part after `site/search.idx/`. Null when it is not a file of the index
 *  (a path that leaves the folder is never one). */
export async function readSearchIndexFile(bundle: StoredBundle, name: string): Promise<{ bytes: Buffer; type: string } | null> {
  const base = resolve(bundle.tree, SEARCH_INDEX_DIR);
  const target = resolve(base, name);
  if (name === "" || name.includes("\0") || !target.startsWith(base + sep)) return null;
  try {
    const bytes = await readFile(target);
    const ext = target.slice(target.lastIndexOf("."));
    return { bytes, type: SEARCH_TYPES[ext] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}
