// Loads what a note needs (needs.ts) on demand: KaTeX when it has math, and
// only the grammars of its code blocks, each its own small chunk. Loaded
// pieces are kept for the page's life, so a note seen once renders fully
// at once the next time.
//
// loadEnhancers returns one promise per set of needs, marked fulfilled the
// way React's `use` reads it: a render after the load doesn't suspend, and
// a server render that awaited loadAllEnhancers() never does.
//
// A load that fails (offline, a deploy replaced the chunks) resolves anyway:
// the note renders plain instead of breaking, and a later render retries.

import type { Pluggable } from "unified";
import { COMMON_GRAMMAR_NAMES, grammarFor, grammarNames, hasAllGrammars, registerMoreGrammars, withEmbedded, type GrammarName, type HighlightScope, type Lowlight } from "./highlight.js";
import { COMMON_LOADERS } from "./grammarLoaders.generated.js";
import type { MarkdownEnhancers } from "./index.js";
import type { MarkdownNeeds } from "./needs.js";

let lowlight: Lowlight | undefined;
let lowlightLoad: Promise<Lowlight> | undefined;
const registered = new Set<GrammarName>();
let katex: Pluggable | undefined;
const loads = new Map<string, Promise<void>>();

/** `needs` with the languages the start-up table couldn't place resolved, once the rest of the table has loaded. */
function resolved(needs: MarkdownNeeds): MarkdownNeeds {
  if (!needs.unresolved?.length || !hasAllGrammars()) return needs;
  const found = needs.unresolved.map(grammarFor).filter((g): g is GrammarName => !!g);
  return { ...needs, grammars: withEmbedded([...needs.grammars, ...found]), unresolved: undefined };
}
const tableWaiting = (needs: MarkdownNeeds) => !!needs.unresolved?.length && !hasAllGrammars();
const wanted = (needs: MarkdownNeeds): readonly GrammarName[] => needs.detect ? withEmbedded([...COMMON_GRAMMAR_NAMES, ...needs.grammars]) : needs.grammars;
const keyOf = (needs: MarkdownNeeds) => `${needs.math ? "math" : ""}|${needs.detect ? "*" : needs.grammars.join(",")}|${needs.unresolved?.join(",") ?? ""}`;

let moreTable: Promise<void> | undefined;
/** The names and aliases outside the start-up table; a failed load is retried by the next call. */
function loadMoreTable(): Promise<void> {
  return moreTable ??= import("./grammarTableMore.generated.js").then(registerMoreGrammars, (error: unknown) => {
    moreTable = undefined;
    throw error;
  });
}

export type LoadedEnhancers = {
  enhancers: MarkdownEnhancers;
  /** Everything `needs` asked for has loaded. */
  ready: boolean;
};

/** What has loaded of `needs`, now. Only what it asks for, so the output
 *  depends on the note, not on what other notes loaded before. */
export function enhancersFor(asked: MarkdownNeeds, onMissing?: HighlightScope["onMissing"]): LoadedEnhancers {
  const needs = resolved(asked);
  const want = wanted(needs);
  const grammars = new Set<string>(want.filter((g) => registered.has(g)));
  const highlight: HighlightScope = { lowlight, grammars, detect: needs.detect && grammars.size === want.length, onMissing };
  return {
    enhancers: { highlight, katex: needs.math ? katex : undefined },
    ready: !tableWaiting(needs) && grammars.size === want.length && (!needs.math || !!katex),
  };
}

/** Load what `needs` asks for. The same promise for the same needs. */
export function loadEnhancers(needs: MarkdownNeeds): Promise<void> {
  const key = keyOf(needs);
  const known = loads.get(key);
  if (known) return known;
  const load = Promise.all([needs.math ? loadKatex() : undefined, loadGrammarsFor(needs)])
    .then(() => undefined, (error: unknown) => {
      loads.delete(key);
      console.warn("Markdown: could not load math or code highlighting", error);
    });
  loads.set(key, track(load));
  return load;
}

/** Everything: for a server render, which has to be synchronous. */
export function loadAllEnhancers(): Promise<void> {
  return loadMoreTable().then(() => loadEnhancers({ math: true, grammars: grammarNames(), detect: true }));
}

async function loadKatex(): Promise<void> {
  if (!katex) katex = (await import("rehype-katex")).default as Pluggable;
}

/** A common grammar from its own chunk; any other through grammarLoadersMore, itself loaded on first use. */
function loadGrammar(name: GrammarName) {
  const common = COMMON_LOADERS[name];
  return common ? common() : import("./grammarLoadersMore.generated.js").then((m) => m.MORE_LOADERS[name]!());
}

async function loadGrammarsFor(asked: MarkdownNeeds): Promise<void> {
  if (tableWaiting(asked)) await loadMoreTable();
  const want = wanted(resolved(asked));
  if (want.length) await loadGrammars(want);
}

async function loadGrammars(names: readonly GrammarName[]): Promise<void> {
  const ll = await (lowlightLoad ??= import("./lowlightCore.js").then(
    (m) => (lowlight = m.emptyLowlight()),
    (error: unknown) => { lowlightLoad = undefined; throw error; },
  ));
  const missing = names.filter((n) => !registered.has(n));
  const grammars = await Promise.all(missing.map((n) => loadGrammar(n)));
  missing.forEach((name, i) => {
    if (registered.has(name)) return;
    ll.register(name, grammars[i]!.default);
    registered.add(name);
  });
}

// React's `use` returns a promise's value without suspending once it carries
// `status: "fulfilled"`.
function track(promise: Promise<void>): Promise<void> {
  const p = promise as Promise<void> & { status?: string; value?: undefined };
  p.status = "pending";
  void promise.then(() => { p.status = "fulfilled"; p.value = undefined; });
  return promise;
}
