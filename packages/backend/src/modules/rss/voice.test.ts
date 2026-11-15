import { describe, expect, it } from "vitest";
import { guessVoice } from "./voice.js";

const by = (...authors: Array<string | null>) => authors.map((author) => ({ author }));

describe("guessVoice", () => {
  it("a personal-writing host is a person", () => {
    expect(guessVoice("https://someone.substack.com/feed", [])).toBe("person");
    expect(guessVoice("https://alice.github.io/atom.xml", by("a", "b", "c"))).toBe("person");
    expect(guessVoice("https://medium.com/feed/@alice", [])).toBe("person");
  });
  it("one author on every one of at least three articles is a person", () => {
    expect(guessVoice("https://example.com/feed", by("Alice Chen", " alice  chen ", "ALICE CHEN"))).toBe("person");
  });
  it("is media when the authors differ, are missing, or too few to say", () => {
    expect(guessVoice("https://news.example.com/rss", by("A", "B", "A"))).toBe("media");
    expect(guessVoice("https://news.example.com/rss", by(null, null, null))).toBe("media");
    expect(guessVoice("https://example.com/feed", by("Alice", "Alice"))).toBe("media");
  });
  it("a generic byline is not a person", () => {
    expect(guessVoice("https://example.com/feed", by("Editor", "Editor", "Editor"))).toBe("media");
    expect(guessVoice("https://example.com/feed", by("編輯部", "編輯部", "編輯部"))).toBe("media");
  });
  it("a host that only ends like a personal one is not one", () => {
    expect(guessVoice("https://notsubstack.com/feed", by("a", "b", "c"))).toBe("media");
    expect(guessVoice("not a url", [])).toBe("media");
  });
});
