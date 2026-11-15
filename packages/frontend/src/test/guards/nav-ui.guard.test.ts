// Guards for the 2026-10-27 dedupe batch (docs/archive/research/review-2026-10-27/deep-modules-nav-ui.md):
// each thing below used to be done several times by hand; now one place owns it, and this
// file reads the source so a second copy cannot grow back unnoticed.
//
// How to read a failure: it names the file and the single owner. Use the owner, do not add the
// file to an allow-list. An allow-list entry needs a reason, and an entry whose file no longer
// has the pattern fails too, so the list never keeps a stale excuse.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "test" && name !== "node_modules") walk(path, out); }
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Source files outside tests, as `src/`-relative posix paths with comment lines blanked. */
const FILES = walk(SRC).map((path) => {
  const text = readFileSync(path, "utf8")
    .split("\n").map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line)).join("\n");
  return { path: relative(SRC, path).split(sep).join("/"), text };
});

type Exceptions = Record<string, string>;

/** Files (outside `owners`) where `pattern` appears, minus the documented exceptions. */
function strays(pattern: RegExp, owners: readonly string[], exceptions: Exceptions = {}) {
  const hits = FILES.filter((f) => pattern.test(f.text) && !owners.some((o) => f.path === o || (o.endsWith("/") && f.path.startsWith(o))));
  return {
    unexpected: hits.map((f) => f.path).filter((p) => !(p in exceptions)),
    stale: Object.keys(exceptions).filter((p) => !hits.some((f) => f.path === p)),
  };
}

function expectOnlyOwner(pattern: RegExp, owners: readonly string[], exceptions: Exceptions = {}) {
  const { unexpected, stale } = strays(pattern, owners, exceptions);
  expect(unexpected, `only ${owners.join(", ")} may contain ${pattern}`).toEqual([]);
  expect(stale, "these exceptions no longer need to be listed").toEqual([]);
}

describe("tab bars (components/ui Tabs)", () => {
  it('role="tablist" is written only by components/ui', () => {
    expectOnlyOwner(/role=["']tablist["']/, ["components/ui/"]);
  });
});

describe("moving a note to another space (lib/moveToSpace)", () => {
  it("spaceApi.move( is called only by moveToSpace", () => {
    expectOnlyOwner(/spaceApi\.move\(/, ["lib/moveToSpace.ts"]);
  });
});

describe("what a heading is (@onden/markdown headingAnchors)", () => {
  // A Markdown heading regex (`#{1,6}`, `(#+)`) outside the shared rule. These read one line the
  // editor or a diff already holds, not a note's outline; a note's headings come from headingAnchors.
  const HEADING_REGEX = /#\{1,\d\}|\(#\+\)/;
  it("lib/ and components/ carry no new heading regex", () => {
    const { unexpected, stale } = strays(HEADING_REGEX, [], {
      "lib/editorFormat.ts": "編輯器對游標所在那一行切換標題層級",
      "modules/review/reviewExtract.ts": "複習模組：判斷一行是不是標題（模組內，另一批）",
    });
    const inScope = (p: string) => p.startsWith("lib/") || p.startsWith("components/") || p.startsWith("hooks/") || p.startsWith("modules/");
    expect(unexpected.filter(inScope), "use headingAnchors / headingAnchorLines from @onden/markdown").toEqual([]);
    expect(stale).toEqual([]);
  });
  it("the info panel's 段落 list reads headings through headingAnchorLines", () => {
    const outline = FILES.find((f) => f.path === "lib/noteOutline.ts")!;
    expect(outline.text).toMatch(/headingAnchorLines/);
    expect(outline.text).not.toMatch(/\bFENCE\b|\bHEADING\b/);
  });
});

describe("history and the URL (hooks/useUrlLocation)", () => {
  it("history.pushState is called only by useUrlLocation", () => {
    expectOnlyOwner(/history\.pushState\(/, ["hooks/useUrlLocation.ts"], {});
  });
  it("history.replaceState is called only by useUrlLocation (lib/pageUrl strips one-shot parameters, never navigates)", () => {
    expectOnlyOwner(/history\.replaceState\(/, ["hooks/useUrlLocation.ts", "lib/pageUrl.ts"], {});
  });
  it("the location's popstate listener is useUrlSync's", () => {
    expectOnlyOwner(/(addEventListener|\bonWindow)\(["']popstate["']/, ["hooks/useUrlLocation.ts"], {});
  });
  it("the graph focus has no store of its own", () => {
    expect(FILES.filter((f) => f.path === "lib/graphFocus.ts")).toEqual([]);
    expect(FILES.filter((f) => /lib\/graphFocus["']/.test(f.text)).map((f) => f.path)).toEqual([]);
  });
});

describe("opening and closing the info pane (hooks/useWorkspacePanes)", () => {
  const PATTERN = /\bsetInspectorOpen\b/;
  it("only useWorkspacePanes sets it; the chord, palette and top bar call panes.toggleInspector", () => {
    expectOnlyOwner(PATTERN, ["hooks/useWorkspacePanes.ts"]);
  });
  it("(self-check) the pattern catches the flip Ctrl+. used to make", () => {
    expect(PATTERN.test("setInspectorOpen((v) => !v);")).toBe(true);
    expect(PATTERN.test("toggleInspector?.();")).toBe(false);
  });
});

describe("one note's relations (lib/noteNeighborhood)", () => {
  it("the screens do not rebuild backlinks or neighbours from edges", () => {
    // components/ get their relations from noteNeighborhood/noteLinks; the graph filter is
    // the graph's own (AllCardsGraph draws every edge, it lists no note's relations).
    expectOnlyOwner(/countsAsBacklink|selectLinkAdjacency|backlinksFor|outgoingFor/, ["lib/noteNeighborhood.ts", "lib/edgeKinds.ts", "lib/edgeRoles.ts"], {
      "components/NoteRelations.tsx": "「未連結的提及」要排除已連結的來源，只用 countsAsBacklink 判斷一條邊（反向連結清單本身來自 noteLinks）",
    });
  });
});

describe("buttons in the create sheet and relations tab (components/ui Button)", () => {
  it.each(["components/CreateSheet.tsx", "components/InfoRelationsTab.tsx"])("%s has no native <button>", (path) => {
    expect(FILES.find((f) => f.path === path)!.text).not.toMatch(/<button[\s>]/);
  });
});
