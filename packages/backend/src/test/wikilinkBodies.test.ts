import { describe, it, expect } from "vitest";
import { wikilinkBodies } from "@onden/markdown";

// The scanner must find exactly what the regex the frontend renders with finds.
const regex = (text: string) => Array.from(text.matchAll(/\[\[([^\]\n]+)\]\]/g)).map((m) => m[1]);

describe("wikilinkBodies matches the [[…]] regex exactly", () => {
  const cases = [
    "plain [[Note]] and [[Other|alias]]", "[[[a]]", "[[a]b]]", "[[]] [[x]]", "[[a\nb]]", "[[ [[x]] ]]",
    "[[a]]]]", "x [[ ]] y", "[[a] [[b]]", "]] [[ [[c]", "[[a]][[b]]", "![[Pasted image A.jpg\n![[Pasted image B.jpg]]", "[[", "]]", "", "[[x|y#h]] [[#only]]",
  ];
  for (const text of cases) it(JSON.stringify(text), () => expect(wikilinkBodies(text)).toEqual(regex(text)));

  it("agrees on random bracket soup", () => {
    const alphabet = ["[", "]", "a", "b", "\n", " ", "|"];
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    for (let n = 0; n < 2000; n++) {
      const text = Array.from({ length: next() % 30 }, () => alphabet[next() % alphabet.length]).join("");
      expect(wikilinkBodies(text), JSON.stringify(text)).toEqual(regex(text));
    }
  });
});
