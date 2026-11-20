// A published site of Chinese course notes, as the owner's looked: a tree of folders (線性代數 › 四大子空間), notes
// that are only folders, six notes called 「講義」, untitled notes, a picture first in a note. What the pages must
// say and show for it — in the site's language, with nothing empty and nothing ambiguous — rendered to strings.
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAllEnhancers } from "@onden/markdown";
import { ArticleFrame, HomeBody, SiteHeader } from "./SiteFrames";
import { coverOf, readSiteData, siteDescription, type SiteData } from "./siteModel";
import type { PublishedNode } from "../templates/publishedCore";

beforeAll(async () => { await loadAllEnhancers(); });

const note = (id: string, title: string, markdown: string, extra: Partial<PublishedNode> = {}): PublishedNode => ({
  id, node_type: "content", title, slug: id, markdown, created_at: "2026-11-07T04:00:00Z", updated_at: "2026-11-07T04:00:00Z", ...extra,
});

const NODES: PublishedNode[] = [
  note("home", "首頁", "# 首頁\n\n這裡放資工系的課程筆記。"),
  note("la", "線性代數", "", { parent_id: null }),
  note("subspaces", "四大子空間", "# 四大子空間\n\n列空間與零空間會互相正交。", { parent_id: "la", updated_at: "2026-11-20T04:00:00Z" }),
  note("la-slides", "講義or線上課程", "# 講義or線上課程\n\n線性代數的講義。", { parent_id: "la" }),
  note("algo", "演算法", "# 演算法\n\n本課程的筆記放在下面。", { parent_id: null }),
  note("algo-slides", "講義or線上課程", "# 講義or線上課程\n\n演算法的講義。", { parent_id: "algo" }),
  note("pdf", "CE2005_Exercise_1", "", {}),
  note("blank-title", "未命名", "第一行就是這篇在寫什麼\n\n後面還有字。"),
  note("blank-title-2", "未命名", ""),
  note("slide", "Ppt離散數學", "# Ppt離散數學\n\n![[Pasted image 20241027003912.jpg\n\n![投影片](/api/media/slide.png)\n\n正文"),
];

const siteOf = (over: { site?: Record<string, unknown>; nodes?: PublishedNode[]; homeNodeId?: string | null } = {}): SiteData => readSiteData({
  title: "我的筆記",
  home_node_id: over.homeNodeId === undefined ? "home" : over.homeNodeId,
  payload: { nodes: over.nodes ?? NODES, edges: [], presentation: { site: { brand: "我的筆記", ...over.site } } },
});
const page = (d: SiteData, id: string) => renderToString(<ArticleFrame data={d} node={d.nodes.find((n) => n.id === id)!} />);

describe("the site's language", () => {
  it("a site with no language of its own speaks Traditional Chinese: words and dates", () => {
    const d = siteOf();
    const out = page(d, "subspaces") + renderToString(<HomeBody data={d} />);
    expect(out).toContain("2026年11月20日");
    expect(out).toMatch(/約 \d+ 分鐘讀完/);
    expect(out).toContain("最近更新");
    expect(out).not.toMatch(/Updated|min read|Latest|All articles|Previous/);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}</); // no ISO date written out
  });

  it("an English site keeps ISO dates and English words", () => {
    const out = page(siteOf({ site: { locale: "en" } }), "subspaces");
    expect(out).toContain("2026-11-20");
    expect(out).toContain("min read");
  });

  it("the description is the site's own, else the home note's first words, else none", () => {
    expect(siteDescription(siteOf({ site: { description: "資工系的課程筆記" } }))).toBe("資工系的課程筆記");
    expect(siteDescription(siteOf())).toBe("這裡放資工系的課程筆記。");
    expect(siteDescription(siteOf({ homeNodeId: null }))).toBeUndefined();
    expect(siteDescription(siteOf())).not.toMatch(/Onden/);
  });
});

describe("a note that is a folder", () => {
  it("with no text lists what is under it: title, date and first line — never an empty article", () => {
    const out = page(siteOf(), "la");
    expect(out).toContain('href="/site/subspaces"');
    expect(out).toContain("四大子空間");
    expect(out).toContain("2026年11月20日");
    expect(out).toContain("列空間與零空間會互相正交");
    expect(out).not.toContain("s-article__empty");
    expect(out).not.toContain('class="s-article__body"');
  });

  it("with text and notes under it shows the text, then the notes", () => {
    const out = page(siteOf(), "algo");
    const body = out.indexOf("本課程的筆記放在下面");
    const list = out.indexOf('class="s-children"');
    expect(body).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(body);
    expect(out).toContain("這篇底下的筆記");
  });

  it("with neither text nor notes says so (a PDF's page has nothing to show here)", () => {
    expect(page(siteOf(), "pdf")).toContain("這一頁沒有文字內容。");
  });

  it("is not what 「Latest」 points at", () => {
    const d = siteOf({ nodes: [...NODES, note("newest-folder", "最新的資料夾", "", { created_at: "2026-11-19T04:00:00Z" })], site: {} });
    const latest = renderToString(<HomeBody data={{ ...d, design: { ...d.design, boxes: { ...d.design.boxes, "home.hero": null, "home.list": [{ widget: "latest", variant: "card" }] } } }} />);
    expect(latest).not.toContain("最新的資料夾");
    expect(latest).toContain("s-latest__title");
  });
});

describe("telling notes apart", () => {
  it("every note page shows the folders above it as a breadcrumb, and search gets the same path", () => {
    const out = page(siteOf(), "subspaces");
    expect(out).toContain('class="s-breadcrumb"');
    expect(out).toContain('<a href="/site/la">線性代數</a>');
    expect(out).toContain('data-pagefind-meta="path:線性代數"');
    expect(page(siteOf(), "la")).not.toContain('class="s-breadcrumb"'); // a top-level note has no folder
  });

  it("notes with the same title show their folder in lists; a title that is alone shows none", () => {
    const d = siteOf();
    const list = renderToString(<HomeBody data={{ ...d, design: { ...d.design, boxes: { ...d.design.boxes, "home.hero": null, "home.list": [{ widget: "recent", variant: "plain" }] } } }} />);
    expect(list.match(/<span class="s-path">線性代數<\/span>/g)).toHaveLength(1);
    expect(list.match(/<span class="s-path">演算法<\/span>/g)).toHaveLength(1);
    expect(list).not.toMatch(/s-path">[^<]*四大子空間/);
  });

  it("an untitled note is listed under its first line, as the app does; with no text it gets the site's word", () => {
    const d = siteOf();
    expect(d.nodes.find((n) => n.id === "blank-title")!.title).toBe("第一行就是這篇在寫什麼");
    expect(d.nodes.find((n) => n.id === "blank-title-2")!.title).toBe("未命名");
    expect(d.nodes.find((n) => n.id === "blank-title")!.slug).toBe("blank-title"); // the address does not move
    expect(siteOf({ site: { locale: "en" } }).nodes.find((n) => n.id === "blank-title-2")!.title).toBe("Untitled");
  });

  it("the home page's short list leaves the rest one tap away", () => {
    const many = Array.from({ length: 14 }, (_, i) => note(`n${i}`, `筆記${i}`, `# 筆記${i}\n\n字`));
    const d = siteOf({ nodes: [...NODES, ...many] });
    const out = renderToString(<HomeBody data={{ ...d, design: { ...d.design, boxes: { ...d.design.boxes, "home.hero": null, "home.list": [{ widget: "all", variant: "recent10" }] } } }} />);
    expect(out).toContain("<details");
    expect(out).toContain("顯示全部");
    for (const n of d.nodes.filter((x) => x.slug.startsWith("n"))) expect(out).toContain(`href="/site/${n.slug}"`);
  });
});

describe("the cover picture", () => {
  const withPicture = "# 標題\n\n![投影片](/api/media/slide.png)\n\n正文";

  it("is not taken from the first picture by itself", () => {
    expect(coverOf(withPicture)).toBeUndefined();
    const out = page(siteOf(), "slide");
    expect(out).not.toContain("s-article__cover");
    expect(out).toContain("slide.png"); // the picture stays in the text where it was written
  });

  it("is the note's choice: `cover: true` takes the first picture, `cover: <address>` that one", () => {
    expect(coverOf(`---\ncover: true\n---\n\n${withPicture}`)).toBe("/api/media/slide.png");
    expect(coverOf(`---\ncover: /api/media/other.png\n---\n\n${withPicture}`)).toBe("/api/media/other.png");
    expect(coverOf(`---\ncover: false\n---\n\n${withPicture}`)).toBeUndefined();
  });

  it("a broken embed is left as the text it is", () => {
    expect(page(siteOf(), "slide")).toContain("![[Pasted image 20241027003912.jpg");
  });
});

describe("search", () => {
  it("the header always has a search button and a panel for it, on a phone as on a desktop", () => {
    const d = siteOf();
    const out = renderToString(<SiteHeader data={d} />);
    expect(out).toContain("data-s-search-open");
    expect(out).toContain("popover=");
    expect(out).toContain("搜尋");
    expect(out).toContain("Ctrl K");
    expect(out).not.toMatch(/<div[^>]*data-s-search[^>]*\shidden/); // the panel is not what hides: only the button, until script runs
  });
});
