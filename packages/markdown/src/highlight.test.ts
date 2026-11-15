import { describe, expect, it, vi } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { readFileSync } from "node:fs";
import { common } from "lowlight";
import hljs from "highlight.js";
import type { Mode } from "highlight.js";
import { ondenMarkdown } from "./full.js";
import { BOOT_GRAMMARS } from "./highlightGrammars.generated.js";
import { MORE_GRAMMARS } from "./grammarTableMore.generated.js";
import {
  ondenMarkdownCore, markdownNeeds, loadEnhancers, enhancersFor, grammarNames, COMMON_GRAMMAR_NAMES, grammarFor, hasAllGrammars,
  type MarkdownEnhancers, type MarkdownProfile,
} from "./index.js";

function html(md: ReturnType<typeof ondenMarkdown>, source: string): string {
  return String(unified().use(remarkParse).use(md.remarkPlugins).use(remarkRehype, md.remarkRehypeOptions)
    .use(md.rehypePlugins).use(rehypeStringify).processSync(md.prepare(source)));
}
const lazy = (source: string, enhancers: MarkdownEnhancers, profile: MarkdownProfile = "published") =>
  html(ondenMarkdownCore({ profile }, enhancers), source);
const full = (source: string, profile: MarkdownProfile = "published") => html(ondenMarkdown({ profile }), source);

describe("grammar table", () => {
  it("is every grammar highlight.js has, with each one's aliases and embedded grammars", () => {
    const names = hljs.listLanguages();
    expect(names.length).toBeGreaterThan(150);
    expect(hasAllGrammars()).toBe(true); // importing full.js registers the whole table
    expect([...grammarNames()].sort()).toEqual([...names].sort());
    const HIGHLIGHT_GRAMMARS = { ...BOOT_GRAMMARS, ...MORE_GRAMMARS };
    for (const name of names) {
      const def = hljs.getLanguage(name)!;
      expect(grammarFor(name), name).toBe(name);
      for (const alias of def.aliases ?? []) {
        // A shared alias (`h`) belongs to one grammar; the others keep their own name.
        expect(grammarFor(alias), alias).toBeDefined();
      }
      const embedded = new Set<string>();
      const seen = new Set<unknown>();
      const walk = (mode: unknown): void => {
        if (!mode || typeof mode !== "object" || seen.has(mode)) return;
        seen.add(mode);
        const sub = (mode as Mode).subLanguage;
        if (sub) [sub].flat().forEach((s) => embedded.add(s));
        Object.values(mode).forEach((v) => (Array.isArray(v) ? v.forEach(walk) : walk(v)));
      };
      walk(def);
      const known = [...embedded].filter((s) => s !== name && names.includes(s)).sort();
      expect([...HIGHLIGHT_GRAMMARS[name as keyof typeof HIGHLIGHT_GRAMMARS]].sort(), name).toEqual(known);
    }
  });

  it("keeps the start-up table to the common grammars and what they embed", () => {
    const boot = Object.keys(BOOT_GRAMMARS);
    for (const name of Object.keys(common)) expect(boot, name).toContain(name);
    for (const name of boot) for (const dep of BOOT_GRAMMARS[name as keyof typeof BOOT_GRAMMARS]) expect(boot, `${name} embeds ${dep}`).toContain(dep);
    expect(Object.keys(MORE_GRAMMARS).filter((n) => boot.includes(n))).toEqual([]);
    expect(boot.length).toBeLessThan(60);
  });

  it("keeps the common set for guessing an untagged block", () => {
    expect([...COMMON_GRAMMAR_NAMES].sort()).toEqual(Object.keys(common).sort());
  });

  it("keeps Onden's short aliases and answers to the new grammars' aliases", () => {
    expect(["js", "ts", "sh", "html", "yml"].map(grammarFor)).toEqual(["javascript", "typescript", "bash", "xml", "yaml"]);
    expect(["hs", "docker", "ps1", "tex", "ex", "erl", "HASKELL"].map(grammarFor))
      .toEqual(["haskell", "dockerfile", "powershell", "latex", "elixir", "erlang", "haskell"]);
    expect(grammarFor("mermaid")).toBeUndefined();
  });

  it("is what the generator makes from the installed highlight.js", async () => {
    const { generate } = await import("../scripts/genGrammars.mjs");
    for (const [file, text] of Object.entries(generate() as Record<string, string>)) {
      expect(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"), `${file}: run npm run gen:grammars`).toBe(text);
    }
  });
});

describe("grammars beyond the common set", () => {
  const samples: Record<string, [string, string]> = {
    haskell: ["haskell", "module Main where\nmain :: IO ()\nmain = putStrLn \"hi\"\n"],
    dockerfile: ["docker", "FROM node:20\nRUN npm ci\nCMD [\"node\", \"x.js\"]\n"],
    elixir: ["elixir", "defmodule A do\n  def f(x), do: x + 1\nend\n"],
    powershell: ["ps1", "function Get-X { param($a) Write-Host $a }\n"],
    latex: ["tex", "\\begin{document}\n\\section{A} text\n\\end{document}\n"],
  };
  for (const [grammar, [tag, code]] of Object.entries(samples)) {
    it(`colours a block tagged ${tag}`, () => {
      const out = full("```" + tag + "\n" + code + "```");
      expect(out).toContain(`language-${tag}`);
      expect(out).toMatch(/<span class="hljs-/);
      expect(grammarFor(tag)).toBe(grammar);
    });
  }

  it("loads on demand only for a tagged block, and matches the server once loaded", async () => {
    const source = "```haskell\nmain :: IO ()\nmain = pure ()\n```";
    const needs = markdownNeeds(source);
    expect(needs.grammars).toEqual(["haskell"]);
    await loadEnhancers(needs);
    const loaded = enhancersFor(needs);
    expect(loaded.ready).toBe(true);
    expect(lazy(source, loaded.enhancers)).toBe(full(source));
  });

  it("guesses an untagged block from the common set only, and ignores unknown languages", async () => {
    const needs = markdownNeeds("```\nx\n```\n\n```haskell\nmain = pure ()\n```");
    expect(needs.detect).toBe(true);
    // Every grammar is registered in the server's lowlight, yet a guess never lands outside `common`.
    const guessed = [
      "FROM node:20\nRUN npm ci\n", "module Main where\nimport Data.List\nmain = print 1\n",
      "defmodule A do\n  def f, do: 1\nend\n", "Get-ChildItem | Where-Object { $_ }\n",
    ].map((code) => /language-([\w-]+)/.exec(full("```\n" + code + "```"))?.[1]);
    for (const lang of guessed) if (lang) expect(COMMON_GRAMMAR_NAMES as readonly string[]).toContain(lang);
    expect(full("```mermaid\ngraph TD\n```")).not.toContain("hljs-");
    // A note with only a rare tagged block and an untagged one loads the common set plus that grammar.
    const { grammars } = needs;
    expect(grammars).toEqual(["haskell"]);
  });
});

describe("markdownNeeds", () => {
  it("reads math and the fences' grammars, with what they embed", () => {
    expect(markdownNeeds("plain text")).toEqual({ math: false, grammars: [], detect: false });
    expect(markdownNeeds("costs $5").math).toBe(true);
    expect(markdownNeeds("costs $5", { math: false }).math).toBe(false);
    expect(markdownNeeds("```py\nx\n```\n\n~~~sql\ny\n~~~")).toEqual({ math: false, grammars: ["python", "sql"], detect: false });
    expect(markdownNeeds("```html\n<b>\n```").grammars).toEqual(["css", "graphql", "handlebars", "javascript", "xml"]);
  });

  it("tells an untagged fence from a closing one", () => {
    expect(markdownNeeds("```js\nx\n```\ntext").detect).toBe(false);
    expect(markdownNeeds("```\nx\n```").detect).toBe(true);
    expect(markdownNeeds("````md\n```\ninner\n```\n````").detect).toBe(false);
  });

  it("finds fences in quotes and list items, and skips langs with no grammar", () => {
    expect(markdownNeeds("> ```rust\n> fn main() {}\n> ```").grammars).toEqual(["rust"]);
    expect(markdownNeeds("- item\n\n  ```go\n  x\n  ```").grammars).toEqual(["go"]);
    expect(markdownNeeds("```mermaid\ngraph TD\n```")).toEqual({ math: false, grammars: [], detect: false });
    expect(markdownNeeds("inline ```js``` code").grammars).toEqual([]);
  });
});

describe("loading what a note needs", () => {
  const samples = [
    "```js\nconst a = 1;\n```",
    "```html\n<script>let a = 1</script><style>a { color: red }</style>\n```",
    "```\nSELECT * FROM t WHERE a = 1;\n```",
    "Euler: $e^{i\\pi} + 1 = 0$\n\n$$\\int_0^1 x\\,dx$$",
    "```mermaid\ngraph TD\n```\n\n```nohighlight\nx\n```",
  ];

  it("uses only the grammars a note asks for, and reports the ones it lacks", async () => {
    // Loaded grammars are kept for the page's life (lazy.ts), and other tests
    // load every grammar: start from a fresh module so none is registered yet.
    vi.resetModules();
    const fresh = await import("./index.js");
    await fresh.loadEnhancers(fresh.markdownNeeds("```python\nx\n```"));
    const missing: string[] = [];
    // An indented block is untagged and the scan doesn't see it: it is
    // reported, and stays plain, even though python is registered.
    const source = "    print(1)\n\n```sql\nselect 1\n```";
    const { enhancers, ready } = fresh.enhancersFor(fresh.markdownNeeds(source), (need) => missing.push(need));
    expect(ready).toBe(false);
    const out = lazy(source, enhancers);
    expect(missing).toEqual(["detect", "sql"]);
    expect(out).not.toContain("hljs-");
    expect(out).toContain('class="hljs language-sql"');
  });

  it("renders what the server renders once loaded", async () => {
    for (const source of samples) {
      const needs = markdownNeeds(source);
      await loadEnhancers(needs);
      const loaded = enhancersFor(needs);
      expect(loaded.ready, source).toBe(true);
      for (const profile of ["app", "published"] as const) expect(lazy(source, loaded.enhancers, profile), source).toBe(full(source, profile));
    }
  });

  it("returns one tracked promise per set of needs", async () => {
    const needs = markdownNeeds("```css\na {}\n```");
    const first = loadEnhancers(needs);
    expect(loadEnhancers(markdownNeeds("```css\nb {}\n```"))).toBe(first);
    await first;
    expect((first as Promise<void> & { status?: string }).status).toBe("fulfilled");
  });

  it("leaves math as its source until KaTeX loads", () => {
    const out = lazy("$x$", {});
    expect(out).not.toContain("katex");
    expect(out).toContain("math-inline");
  });
});

describe("a grammar outside the start-up table", () => {
  it("is placed, loaded and coloured on demand", async () => {
    vi.resetModules();
    const fresh = await import("./index.js");
    expect(fresh.hasAllGrammars()).toBe(false);
    const source = "```haskell\nmain :: IO ()\nmain = pure ()\n```\n\n```mermaid\ngraph TD\n```";
    const needs = fresh.markdownNeeds(source);
    expect(needs).toEqual({ math: false, grammars: [], detect: false, unresolved: ["haskell", "mermaid"] });
    expect(fresh.enhancersFor(needs).ready).toBe(false);
    await fresh.loadEnhancers(needs);
    expect(fresh.hasAllGrammars()).toBe(true);
    const loaded = fresh.enhancersFor(needs);
    expect(loaded.ready).toBe(true);
    const out = lazy(source, loaded.enhancers);
    expect(out).toContain('class="hljs language-haskell"');
    expect(out).toMatch(/hljs-/);
    expect(out).not.toContain("language-mermaid\"><span");
    expect(fresh.markdownNeeds(source).grammars).toEqual(["haskell"]);
  });

  it("gives the editor tokens once its grammar has loaded, and none for an unknown language", async () => {
    vi.resetModules();
    const fresh = await import("./index.js");
    const loaded = vi.fn();
    expect(fresh.codeHighlighter("haskell", loaded)).toBeUndefined();
    await vi.waitFor(() => expect(loaded).toHaveBeenCalled());
    const colour = fresh.codeHighlighter("hs", () => undefined)!;
    expect(JSON.stringify(colour("main = pure ()\n"))).toContain("hljs-");
    expect(fresh.codeHighlighter("not-a-language", () => undefined)).toBeUndefined();
  });

  it("is not part of the guess for an untagged block", async () => {
    vi.resetModules();
    const fresh = await import("./index.js");
    const needs = fresh.markdownNeeds("```\nmain :: IO ()\n```\n\n```elixir\nIO.puts 1\n```");
    await fresh.loadEnhancers(needs);
    const out = lazy("```\nmodule Main where\nimport Data.List\nmain :: IO ()\nmain = print 1\n```", fresh.enhancersFor(needs).enhancers);
    for (const m of out.matchAll(/language-([\w-]+)/g)) expect(COMMON_GRAMMAR_NAMES as readonly string[]).toContain(m[1]);
  });
});
