import { describe, expect, it } from "vitest";
import { slugify } from "./slug.js";
import { HASHTAG_RE, linkNamesNote, wikilinkTarget } from "./text.js";
import { attributeLines } from "./attributeLines.js";
import { isAttributeKey } from "./attributeKey.js";
import { entryFor, readFrontmatter, entryValue } from "./frontmatter.js";
import { servedLinkTarget } from "./sitePath.js";
import { normalizeText, WORD_CHAR } from "./word.js";

// D58: combining marks are part of a word, and names are compared in NFC.
const NFD_CAFE = "Café";         // "Café" as a macOS zip names it
const NFD_HANGUL = "한글".normalize("NFD"); // conjoining jamo

describe("word characters and NFC (D58)", () => {
  it("a word character is a letter, mark or digit of any script", () => {
    const word = new RegExp(`^${WORD_CHAR}+$`, "u");
    for (const w of ["हिंदी", "ภาษาไทย", "বাংলা", "讀書", "x2", NFD_CAFE]) expect(word.test(w)).toBe(true);
    expect(word.test("a-b")).toBe(false);
    expect(normalizeText(NFD_CAFE)).toBe("Café");
    expect(normalizeText(NFD_HANGUL)).toBe("한글");
  });

  it("(1) a slug keeps a script's vowel signs", () => {
    expect(slugify("हिंदी")).toBe("हिंदी");
    expect(slugify("ภาษา ไทย")).toBe("ภาษา-ไทย");
  });

  it("(2) words that differ only in marks get different slugs and links", () => {
    const slugs = ["कल", "काल", "कील"].map((w) => slugify(w));
    expect(new Set(slugs).size).toBe(3);
    const kaal = { title: "काल", slug: slugify("काल") };
    expect(linkNamesNote("कल", kaal)).toBe(false);
    expect(linkNamesNote("कील", kaal)).toBe(false);
    expect(linkNamesNote("काल", kaal)).toBe(true);
  });

  it("(3) #हिंदी is a hashtag, whole", () => {
    const names = (text: string) => Array.from(text.matchAll(HASHTAG_RE), (m) => m[2]);
    expect(names("पढ़ो #हिंदी and #ไทย")).toEqual(["हिंदी", "ไทย"]);
  });

  it("(4) कीमत:: 5 is an attribute, in every form, and its key exports", () => {
    expect(attributeLines("कीमत:: 5\n[लेखक:: राम] #स्थिति=पूर्ण")).toEqual([
      { line: 1, form: "line", key: "कीमत", value: "5" },
      { line: 2, form: "bracket", key: "लेखक", value: "राम" },
      { line: 2, form: "hashtag", key: "स्थिति", value: "पूर्ण" },
    ]);
    expect(isAttributeKey("कीमत")).toBe(true);
    const entry = entryFor("कीमत", "हिंदी");
    expect(entry.lines).toEqual(["कीमत: हिंदी"]);
    const back = readFrontmatter(`---\n${entry.lines.join("\n")}\n---\nbody`)!.entries[0]!;
    expect(back.key).toBe("कीमत");
    expect(entryValue(back)).toBe("हिंदी");
  });

  it("(5) an NFD title and an NFC link name each other", () => {
    expect(slugify(NFD_CAFE)).toBe(slugify("Café"));
    expect(slugify(NFD_HANGUL)).toBe("한글");
    expect(wikilinkTarget(`${NFD_CAFE}#top|alias`)).toBe("Café");
    // A note stored before D58 with an NFD title (and the old slug) is still
    // found by an NFC link, and an NFD link finds an NFC title.
    expect(linkNamesNote("café", { title: NFD_CAFE, slug: "cafe" })).toBe(true);
    expect(linkNamesNote(NFD_HANGUL, { title: "한글", slug: "한글" })).toBe(true);
    expect(linkNamesNote("café", { title: "Other", aliases: [NFD_CAFE] })).toBe(true);
    const served = [{ id: "a", title: NFD_CAFE, slug: "cafe" }];
    expect(servedLinkTarget("Café", served)?.id).toBe("a");
    // An attribute key read from NFD text comes back NFC.
    expect(attributeLines(`${NFD_CAFE}:: 1`)[0]!.key).toBe("Café");
  });
});
