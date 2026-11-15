import { describe, it, expect } from "vitest";
import { stripTrailing, trimLineSpaces } from "../lib/textScan";
import { wikilinkBodies, replaceWikilinks } from "@onden/markdown";

// The scanner must find exactly what the regex it replaces found (and what the
// backend's twin finds: packages/backend/src/test/wikilinkBodies.test.ts).
const regex = (text: string) => Array.from(text.matchAll(/\[\[([^\]\n]+)\]\]/g)).map((m) => m[1]);

describe("textScan matches the regexes it replaces", () => {
  const cases = [
    "plain [[Note]] and [[Other|alias]]", "[[[a]]", "[[a]b]]", "[[]] [[x]]", "[[a\nb]]", "[[ [[x]] ]]",
    "[[a]]]]", "x [[ ]] y", "[[a] [[b]]", "]] [[ [[c]", "[[a]][[b]]", "![[Pasted image A.jpg\n![[Pasted image B.jpg]]", "[[", "]]", "",
  ];
  for (const text of cases) it(JSON.stringify(text), () => {
    expect(wikilinkBodies(text)).toEqual(regex(text));
    expect(replaceWikilinks(text, (b) => `<${b}>`)).toBe(text.replace(/\[\[([^\]\n]+)\]\]/g, "<$1>"));
  });

  it("agrees on random bracket soup", () => {
    const alphabet = ["[", "]", "a", "b", "\n", " ", "|"];
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    for (let n = 0; n < 2000; n++) {
      const text = Array.from({ length: next() % 30 }, () => alphabet[next() % alphabet.length]).join("");
      expect(wikilinkBodies(text), JSON.stringify(text)).toEqual(regex(text));
    }
  });

  it("stripTrailing and trimLineSpaces do what their regexes did", () => {
    for (const s of ["a. .", "a", "...", "", "a .b. "]) expect(stripTrailing(s, ". ")).toBe(s.replace(/[. ]+$/u, ""));
    for (const s of ["a  \n  b", " x \n\n y ", "\n", "a"]) {
      expect(trimLineSpaces(s).trim()).toBe(s.replace(/ *\n */g, "\n").trim());
    }
  });
});
