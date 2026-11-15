// The stored static copy (modules/website/publishing/siteBundle.ts) and the search
// index in it (siteSearchIndex.ts): made once per served site and reused, remade
// when a takedown changes the site, never visible half-written, old copies
// removed, and searchable — Chinese included — with only what the site serves.
// The served site and the frontend are stubbed; Pagefind is the real binary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Note = { slug: string; title: string; text: string };
const state = vi.hoisted(() => ({ id: "snap-1", notes: [] as Note[], rev: 0 }));

vi.mock("../modules/website/publishing/mediaBundle.js", () => ({ bundleSiteFiles: async (files: unknown[]) => files }));
// Only the read is stubbed: the bundle key hashes the stub through the real servedSiteVersion.
vi.mock("../modules/website/publishing/servedSite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules/website/publishing/servedSite.js")>()),
  loadServedSite: async () => ({ id: state.id, payload: { nodes: state.notes, rev: state.rev } }),
}));

import { currentBundleKey, ensureSiteBundle, readBundleFiles, readSearchIndexFile, storedSiteBundle } from "../modules/website/publishing/siteBundle.js";
import { SEARCH_INDEX_DIR, retargetStaticSite } from "../modules/website/publishing/staticSite.js";
import { indexStaticSite } from "../modules/website/publishing/siteSearchIndex.js";
import { searchIndex } from "./helpers/pagefindSearch.js";

const ALPHA: Note = { slug: "alpha", title: "學習筆記", text: "今天學習了資料結構與演算法，二元搜尋樹很有趣。" };
const BETA: Note = { slug: "beta", title: "Garden", text: "Tomatoes need sunlight and patient watering." };

const article = (n: Note) =>
  `<!DOCTYPE html><html class="onden-site" lang="zh-TW"><head><meta charset="UTF-8"><title>${n.title}</title></head>` +
  `<body><header><a href="/site/">首頁導覽</a></header><main><article data-pagefind-body><h1>${n.title}</h1>` +
  `<p>${n.text}</p></article></main></body></html>`;

/** A frontend answering the contract staticSite.ts crawls, for the notes the
 *  stubbed served site holds now. `gate` lets a test hold the crawl mid-way. */
function frontend(opts: { gate?: Promise<void> } = {}): { fetchImpl: typeof fetch; crawls: () => number } {
  let crawls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    const reply = (status: number, type: string, body: string) => new Response(body, { status, headers: { "content-type": type } });
    if (path === "/site/static-pages.json") {
      crawls++;
      await opts.gate;
      return reply(200, "application/json", JSON.stringify({ pages: ["/site/", ...state.notes.map((n) => `/site/${n.slug}/`)], origin: "https://live.example", allowIndexing: true }));
    }
    if (path === "/site/") return reply(200, "text/html", `<!DOCTYPE html><html lang="zh-TW"><head><title>Home</title></head><body><main>${state.notes.map((n) => `<a href="/site/${n.slug}/">${n.title}</a> ${n.text}`).join("")}</main></body></html>`);
    const note = state.notes.find((n) => `/site/${n.slug}/` === path);
    if (note) return reply(200, "text/html", article(note));
    if (path === "/site/feed.xml" || path === "/site/sitemap.xml") return reply(200, "application/xml", "<x/>");
    return reply(404, "text/html", "<!DOCTYPE html><html><head><title>404</title></head><body>none</body></html>");
  }) as typeof fetch;
  return { fetchImpl, crawls: () => crawls };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "onden-bundle-"));
  state.id = "snap-1";
  state.notes = [ALPHA, BETA];
  state.rev = 0;
});
afterEach(async () => {
  delete process.env.ONDEN_BUILD_ID;
  await rm(root, { recursive: true, force: true });
});

const opts = (fe: ReturnType<typeof frontend>) => ({ workspaceId: "ws", root, ssrUrl: "http://frontend", fetchImpl: fe.fetchImpl });
const copies = async () => (await readdir(root)).filter((n) => /^[0-9a-f]{32}$/.test(n));
const searchTree = (bundle: { tree: string }, q: string) =>
  searchIndex(join(bundle.tree, SEARCH_INDEX_DIR), async (name) => readFile(join(bundle.tree, SEARCH_INDEX_DIR, name)).catch(() => null), q);
const searchLive = (bundle: Parameters<typeof readSearchIndexFile>[0], q: string) =>
  searchIndex(join(bundle.tree, SEARCH_INDEX_DIR), async (name) => (await readSearchIndexFile(bundle, name))?.bytes ?? null, q);

describe("made once, reused", () => {
  it("two zip downloads, or a zip and a push, crawl the frontend once", async () => {
    const fe = frontend();
    const first = await ensureSiteBundle(opts(fe));
    const second = await ensureSiteBundle(opts(fe));
    expect(second.key).toBe(first.key);
    expect(fe.crawls()).toBe(1);
    const files = await readBundleFiles(second);
    expect(files.map((f) => f.path)).toContain("site/alpha/index.html");
  });

  it("askers at the same moment share one build", async () => {
    let release!: () => void;
    const fe = frontend({ gate: new Promise<void>((r) => { release = r; }) });
    const pending = [ensureSiteBundle(opts(fe)), ensureSiteBundle(opts(fe)), ensureSiteBundle(opts(fe))];
    await new Promise((r) => setTimeout(r, 50));
    release();
    const keys = (await Promise.all(pending)).map((b) => b.key);
    expect(new Set(keys).size).toBe(1);
    expect(fe.crawls()).toBe(1);
  });

  it("the key follows the served site and the frontend build", async () => {
    const before = await currentBundleKey("ws");
    expect(await currentBundleKey("ws")).toBe(before);
    process.env.ONDEN_BUILD_ID = "deadbeef";
    expect(await currentBundleKey("ws")).not.toBe(before);
    delete process.env.ONDEN_BUILD_ID;
    state.id = "snap-2";
    expect(await currentBundleKey("ws")).not.toBe(before);
  });

  it("a takedown changes the key: the copy made before it is never the site's now", async () => {
    const fe = frontend();
    const before = await ensureSiteBundle(opts(fe));
    state.notes = [BETA]; // alpha taken down, same snapshot
    expect(await storedSiteBundle({ ...opts(fe) })).toBeNull();
    const after = await ensureSiteBundle(opts(fe));
    expect(after.key).not.toBe(before.key);
    expect(fe.crawls()).toBeGreaterThanOrEqual(2);
    const paths = (await readBundleFiles(after)).map((f) => f.path);
    expect(paths).not.toContain("site/alpha/index.html");
    expect(paths).toContain("site/beta/index.html");
  });
});

describe("never partial, never piling up", () => {
  it("while a copy is being made only a temporary folder exists; it appears whole afterwards", async () => {
    let release!: () => void;
    const fe = frontend({ gate: new Promise<void>((r) => { release = r; }) });
    const job = ensureSiteBundle(opts(fe));
    await new Promise((r) => setTimeout(r, 50));
    expect(await copies()).toEqual([]);
    release();
    const bundle = await job;
    expect(await copies()).toEqual([bundle.key]);
    expect((await readdir(root)).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
    expect((await readdir(join(root, bundle.key))).sort()).toEqual(["manifest.json", "tree"]);
  });

  it("a failed crawl leaves nothing behind and the next ask builds again", async () => {
    const broken = frontend();
    const failing = { ...opts(broken), fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch };
    await expect(ensureSiteBundle(failing)).rejects.toThrow(/cannot reach/);
    expect(await readdir(root)).toEqual([]);
    const ok = await ensureSiteBundle(opts(frontend()));
    expect(await copies()).toEqual([ok.key]);
  });

  it("old copies are removed: only the newest two stay", async () => {
    const fe = frontend();
    const keys: string[] = [];
    for (let rev = 1; rev <= 4; rev++) {
      state.rev = rev;
      keys.push((await ensureSiteBundle(opts(fe))).key);
      await new Promise((r) => setTimeout(r, 15)); // distinct modification times
    }
    expect((await copies()).sort()).toEqual([keys[2], keys[3]].sort());
  });
});

describe("search index", () => {
  it("ships inside the copy and finds a note's text, a Chinese word included", async () => {
    const bundle = await ensureSiteBundle(opts(frontend()));
    const paths = (await readBundleFiles(bundle)).map((f) => f.path);
    expect(paths).toContain(`${SEARCH_INDEX_DIR}/pagefind.js`);
    expect(paths).toContain(`${SEARCH_INDEX_DIR}/pagefind-entry.json`);

    expect((await searchTree(bundle, "資料結構")).map((h) => h.url)).toEqual(["/site/alpha/"]);
    expect((await searchTree(bundle, "演算法")).map((h) => h.title)).toEqual(["學習筆記"]);
    expect((await searchTree(bundle, "二元")).map((h) => h.url)).toEqual(["/site/alpha/"]);
    expect((await searchTree(bundle, "tomatoes")).map((h) => h.url)).toEqual(["/site/beta/"]);
  });

  it("every build writes the whole index: the same bytes each time, none cut short", async () => {
    // Pagefind answers writeFiles() before its helper process has finished
    // writing, and the helper is killed right after: about one build in thirty
    // left pagefind-ui.js cut at 64 KB or the wasm empty, for good, in a stored copy.
    const built: Array<Map<string, Buffer>> = [];
    for (let i = 0; i < 30; i++) {
      const tree = join(root, `tree-${i}`);
      for (const n of [ALPHA, BETA]) {
        await mkdir(join(tree, "site", n.slug), { recursive: true });
        await writeFile(join(tree, "site", n.slug, "index.html"), article(n));
      }
      await indexStaticSite(tree);
      const dir = join(tree, SEARCH_INDEX_DIR);
      const files = new Map<string, Buffer>();
      for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (e.isFile()) files.set(join(e.parentPath, e.name).slice(dir.length), await readFile(join(e.parentPath, e.name)));
      }
      built.push(files);
    }
    const first = built[0]!;
    expect(first.get("/pagefind-ui.js")!.length).toBeGreaterThan(65_536);
    expect(first.get("/wasm.unknown.pagefind")!.length).toBeGreaterThan(0);
    for (const files of built) {
      expect([...files.keys()].sort()).toEqual([...first.keys()].sort());
      for (const [name, bytes] of files) expect(bytes.equals(first.get(name)!), `${name}: ${bytes.length} bytes`).toBe(true);
    }
  }, 60_000);

  it("indexes the article only: not the header, and not the home page's listing", async () => {
    const bundle = await ensureSiteBundle(opts(frontend()));
    expect(await searchTree(bundle, "首頁導覽")).toEqual([]);
    // the home page repeats every note's text; the index must not point at it
    const hits = await searchTree(bundle, "sunlight");
    expect(hits.map((h) => h.url)).toEqual(["/site/beta/"]);
  });

  it("text that is not served (unpublished, taken down) is not in the index", async () => {
    const fe = frontend();
    await ensureSiteBundle(opts(fe));
    state.notes = [BETA]; // alpha taken down
    const after = await ensureSiteBundle(opts(fe));
    expect(await searchTree(after, "資料結構")).toEqual([]);
    expect(await searchTree(after, "學習筆記")).toEqual([]);
    expect((await searchTree(after, "tomatoes")).map((h) => h.url)).toEqual(["/site/beta/"]);
    const everything = (await readBundleFiles(after)).filter((f) => typeof f.content === "string").map((f) => f.content).join("");
    expect(everything).not.toContain("資料結構");
  });

  it("the live route's files give the same results as the copy's own", async () => {
    const bundle = await ensureSiteBundle(opts(frontend()));
    for (const q of ["資料結構", "演算法", "tomatoes", "樹", "nothing-here"]) {
      expect(await searchLive(bundle, q), q).toEqual(await searchTree(bundle, q));
    }
  });

  it("serves index files only, with a type the browser can run, and nothing outside the folder", async () => {
    const bundle = await ensureSiteBundle(opts(frontend()));
    expect((await readSearchIndexFile(bundle, "pagefind.js"))?.type).toMatch(/^text\/javascript/);
    expect((await readSearchIndexFile(bundle, "pagefind-entry.json"))?.type).toMatch(/^application\/json/);
    expect(await readSearchIndexFile(bundle, "../index.html")).toBeNull();
    expect(await readSearchIndexFile(bundle, "../../404.html")).toBeNull();
    expect(await readSearchIndexFile(bundle, "")).toBeNull();
    expect(await readSearchIndexFile(bundle, "nope.js")).toBeNull();
  });
});

describe("the Pages push reads the same copy", () => {
  it("applies the Pages address to the stored files, search index untouched", async () => {
    const bundle = await ensureSiteBundle(opts(frontend()));
    const files = await readBundleFiles(bundle);
    const pushed = retargetStaticSite({ files, facts: bundle.facts }, "https://me.github.io/garden/");
    expect(pushed.map((f) => f.path)).toEqual(files.map((f) => f.path));
    const index = (list: typeof files) => list.filter((f) => f.path.startsWith(SEARCH_INDEX_DIR));
    expect(index(pushed)).toEqual(index(files));
  });
});
