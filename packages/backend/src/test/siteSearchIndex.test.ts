// The search index of a site written in Chinese: a word from the middle of a note's text is found, not only
// a word of its title, and a one-character query is answered, not an error. Pagefind splits Chinese text into
// words only when the page's <html lang> says it is Chinese (the site's language), which is why a site left
// in English could not find 「正交」 in a note that holds it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexStaticSite } from "../modules/website/publishing/siteSearchIndex.js";
import { SEARCH_INDEX_DIR } from "../modules/website/publishing/staticSite.js";
import { searchIndex } from "./helpers/pagefindSearch.js";

let tree: string;
beforeEach(async () => { tree = await mkdtemp(join(tmpdir(), "onden-zh-index-")); });
afterEach(async () => { await rm(tree, { recursive: true, force: true }); });

const page = (lang: string, title: string, text: string) =>
  `<!DOCTYPE html><html lang="${lang}"><head><title>${title}</title></head><body><header>搜尋 首頁</header>` +
  `<article data-pagefind-body><h1>${title}</h1><p>${text}</p></article></body></html>`;

async function write(slug: string, html: string) {
  await mkdir(join(tree, "site", slug), { recursive: true });
  await writeFile(join(tree, "site", slug, "index.html"), html);
}
const search = (query: string) => {
  const dir = join(tree, SEARCH_INDEX_DIR);
  return searchIndex(dir, (name) => readFile(join(dir, name)).catch(() => null), query);
};

describe("a Chinese site's search", () => {
  beforeEach(async () => {
    await write("subspaces", page("zh-TW", "四大子空間", "列空間與零空間會互相正交，這是線性代數的重點。"));
    await write("sorting", page("zh-TW", "排序演算法", "合併排序把序列切成兩半再合併。"));
  });

  it("finds a two-character word from the body, not only from the title", async () => {
    await indexStaticSite(tree);
    expect((await search("正交")).map((h) => h.url)).toEqual(["/site/subspaces/"]);
    expect((await search("互相正交")).map((h) => h.url)).toEqual(["/site/subspaces/"]);
    expect((await search("合併")).map((h) => h.url)).toEqual(["/site/sorting/"]);
  });

  it("answers a one-character query, with or without hits, without failing", async () => {
    await indexStaticSite(tree);
    await expect(search("交")).resolves.toBeInstanceOf(Array);
    await expect(search("a")).resolves.toEqual([]);
  });
});
