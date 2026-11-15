// Property tests for the wikilink grammar (text.ts, wikilinkSpans.ts) through
// the package entry. DB-free; seed and run count from PROPS_SEED / PROPS_RUNS.
//
// Invariants: splitting a body and putting it back is the identity, `![[` and
// `[[` are the same link, links inside code / math are not drawn (but the raw
// scan still sees them), and rewriting the links to A touches nothing else.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { scanWikilinks, replaceWikilinks, splitWikilink, wikilinkBodies, wikilinkTarget, drawnWikilinks, embedMatches } from "../../index.js";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

// Hostile pieces: brackets, bars, anchors, CJK, emoji (surrogate pairs),
// zero-width characters, both line endings.
const rawAtom = fc.constantFrom(
  "a", "B", "0", " ", "[", "]", "[[", "]]", "![[", "|", "#", "^", "`", "$", "$$", "\n", "\r\n", "!",
  "字", "測", "日本語", "한", "😀", "👩‍👩‍👧", "🇹🇼", "​", "‍", "é", "́",
);
const rawText = fc.array(rawAtom, { maxLength: 40 }).map((a) => a.join(""));

// Names that are safe inside a link and in a Markdown line: no brackets, bars,
// anchors, markers, edge blanks.
const nameChar = fc.constantFrom("a", "b", "Z", "7", "字", "測", "日", "本", "語", "한", "😀", "🦊", "é", "​", "-", "_", "x y");
const name = fc.array(nameChar, { minLength: 1, maxLength: 6 }).map((a) => a.join("")).filter((s) => s.trim() === s && s.length > 0 && !s.includes("​".repeat(1) + " "));
const aliasText = fc.array(fc.constantFrom("al", "別名", "😀", "x|y", "#h", "^i"), { maxLength: 3 }).map((a) => a.join("")).filter((s) => s.length > 0 && s.trim() === s);

type Piece = { text: string; body: string | null; live: boolean };
const linkBody = fc.oneof(
  name,
  fc.tuple(name, aliasText).map(([n, a]) => `${n}|${a}`),
  fc.tuple(name, name).map(([n, h]) => `${n}#${h}`),
  fc.tuple(name, fc.constantFrom("abc", "x-1")).map(([n, id]) => `${n}#^${id}`),
);
// Text with links and embeds in it but no stray `[` (a `[[` inside another
// link's body is ambiguous by design: the first `]]` closes it).
const linkyText = fc.array(
  fc.oneof(
    fc.constantFrom("a", " ", "]", "|", "#", "\n", "\r\n", "!", "字", "😀", "\u200b", "`", "$$"),
    linkBody.map((b) => `[[${b}]]`),
    linkBody.map((b) => `![[${b}]]`),
  ),
  { maxLength: 12 },
).map((a) => a.join(""));

// A piece of a note: plain text, a live link (embed or not), or the same link
// inside inline code, a code fence or a math block.
// An embed `![[x]]` is not a drawn link (embeds.ts reads it: `![` starts an
// image for the parser), so it counts for the raw scan only.
const piece: fc.Arbitrary<Piece> = fc.oneof(
  fc.constantFrom("hello", "你好 😀", "", "​").map((text) => ({ text, body: null, live: false })),
  linkBody.map((b) => ({ text: `[[${b}]]`, body: b, live: true })),
  linkBody.map((b) => ({ text: `![[${b}]]`, body: b, live: false })),
  linkBody.map((b) => ({ text: `\`[[${b}]]\``, body: b, live: false })),
  fc.tuple(linkBody, fc.constantFrom("```", "~~~")).map(([b, f]) => ({ text: `\n${f}\n[[${b}]]\n${f}\n`, body: b, live: false })),
  linkBody.map((b) => ({ text: `\n$$\n[[${b}]]\n$$\n`, body: b, live: false })),
);
const doc = fc.tuple(fc.array(piece, { maxLength: 8 }), fc.boolean()).map(([pieces, crlf]) => {
  // One piece per line so a link never touches its neighbour's characters.
  const text = pieces.map((p) => p.text).join("\n\n");
  return { pieces, text: crlf ? text.replace(/\n/g, "\r\n") : text };
});

describe("splitWikilink / replaceWikilinks", () => {
  it("target + alias put back give the body; the alias keeps every later `|`", () => {
    fc.assert(fc.property(rawText, (body) => {
      const { target, alias } = splitWikilink(body);
      expect(alias === null ? target : `${target}|${alias}`).toBe(body);
      expect(target).not.toContain("|");
      if (alias === null) expect(body).not.toContain("|");
    }), fcOpts);
  });

  it("a made link splits back into the target and alias it was made from", () => {
    fc.assert(fc.property(name, fc.option(aliasText, { nil: null }), (n, a) => {
      const split = splitWikilink(a === null ? n : `${n}|${a}`);
      expect(split).toEqual({ target: n, alias: a });
    }), fcOpts);
  });

  it("replacing each link by itself is the identity", () => {
    fc.assert(fc.property(rawText, (text) => {
      expect(replaceWikilinks(text, (_body, full) => full)).toBe(text);
      expect(replaceWikilinks(text, (body) => `[[${body}]]`)).toBe(text);
    }), fcOpts);
  });

  it("the scan's spans are ordered, disjoint, one line, and slice back to `[[body]]`", () => {
    fc.assert(fc.property(rawText, (text) => {
      let last = 0;
      for (const m of scanWikilinks(text)) {
        expect(m.start).toBeGreaterThanOrEqual(last);
        expect(text.slice(m.start, m.end)).toBe(`[[${m.body}]]`);
        expect(m.body).not.toMatch(/[\]\n]/);
        expect(m.body.length).toBeGreaterThan(0);
        last = m.end;
      }
    }), fcOpts);
  });

  it("`![[x]]` is the same link as `[[x]]`: same bodies, and a rewrite keeps the `!`", () => {
    fc.assert(fc.property(linkyText, (text) => {
      const plain = text.replaceAll("![[", "[[");
      const embedded = plain.replaceAll("[[", "![[");
      expect(wikilinkBodies(embedded)).toEqual(wikilinkBodies(plain));
      const mark = (s: string) => replaceWikilinks(s, (body) => `[[<${body}>]]`);
      expect(mark(embedded)).toBe(mark(plain).replaceAll("[[", "![["));
    }), fcOpts);
  });

  it("the embed scan finds exactly the links that have a `!` in front of them", () => {
    fc.assert(fc.property(linkyText, (text) => {
      const withBang = scanWikilinks(text).filter((m) => text[m.start - 1] === "!");
      const embeds = embedMatches(text);
      expect(embeds.map((e) => e.body)).toEqual(withBang.map((m) => m.body));
      for (const e of embeds) expect(text.slice(e.start, e.end)).toBe(`![[${e.body}]]`);
    }), fcOpts);
  });
});

describe("links in code, math and embeds", () => {
  it("the raw scan finds every link in the note, code included, in order", () => {
    fc.assert(fc.property(doc, ({ pieces, text }) => {
      expect(wikilinkBodies(text)).toEqual(pieces.flatMap((p) => (p.body === null ? [] : [p.body])));
    }), fcOpts);
  });

  it("drawn links are exactly the plain `[[…]]` outside inline code, fences and `$$` math", () => {
    fc.assert(fc.property(doc, ({ pieces, text }) => {
      const drawn = drawnWikilinks(text);
      expect(drawn.map((m) => m.body)).toEqual(pieces.flatMap((p) => (p.live ? [p.body!] : [])));
      for (const m of drawn) expect(text.slice(m.start, m.end)).toBe(`[[${m.body}]]`);
    }), fcOpts);
  });

  it("every drawn link is also found by the raw scan, at the same span", () => {
    fc.assert(fc.property(doc, ({ text }) => {
      const raw = new Set(scanWikilinks(text).map((m) => `${m.start}:${m.end}`));
      for (const m of drawnWikilinks(text)) expect(raw.has(`${m.start}:${m.end}`)).toBe(true);
    }), fcOpts);
  });
});

describe("renaming the links to A", () => {
  // The rewrite the backend does for a renamed note, through the public
  // spans: only drawn links whose target is `from` change, the alias and the
  // `#heading` / `#^block` part stay.
  const rename = (text: string, from: string, to: string): string => {
    let out = text;
    for (const m of drawnWikilinks(text).reverse()) {
      if (wikilinkTarget(m.body) !== from || !m.body.startsWith(from)) continue;
      out = out.slice(0, m.start) + `[[${to}${m.body.slice(from.length)}]]` + out.slice(m.end);
    }
    return out;
  };
  // Names are drawn from disjoint pools so `to` never occurs in the note.
  const fromName = fc.constantFrom("Alpha", "測試筆記", "😀 Fox");
  const toName = fc.constantFrom("Beta Two", "新名字", "🦊 Renamed");
  const other = fc.constantFrom("Other", "別的", "Alphabet");
  type Item = { name: string; tail: string; how: "plain" | "inline" | "fence" };
  const item: fc.Arbitrary<Item> = fc.record({
    name: fc.oneof(fromName, other),
    tail: fc.constantFrom("", "|al", "#h", "#^id1", "#h|al"),
    how: fc.constantFrom("plain", "inline", "fence"),
  });
  const draw = ({ name, tail, how }: Item): string => {
    const raw = `[[${name}${tail}]]`;
    return how === "inline" ? `\`${raw}\`` : how === "fence" ? `\n\`\`\`\n${raw}\n\`\`\`\n` : raw;
  };
  const note = fc.array(item, { maxLength: 8 });

  it("changes only the plain links to A; renaming twice is renaming once; renaming back restores the note", () => {
    fc.assert(fc.property(note, fromName, toName, (items, from, to) => {
      const text = items.map(draw).join("\n\n");
      const once = rename(text, from, to);
      // The model: a link is renamed iff it is plain text and names `from`.
      const expected = items.map((i) => draw(i.how === "plain" && i.name === from ? { ...i, name: to } : i)).join("\n\n");
      expect(once).toBe(expected);
      expect(rename(once, from, to)).toBe(once);
      expect(rename(once, to, from)).toBe(text);
    }), fcOpts);
  });

  it("keeps the alias and anchor of each renamed link", () => {
    fc.assert(fc.property(fromName, toName, fc.constantFrom("", "|al", "#h", "#^id1", "#h|al"), (from, to, tail) => {
      expect(rename(`see [[${from}${tail}]] here`, from, to)).toBe(`see [[${to}${tail}]] here`);
    }), fcOpts);
  });
});
