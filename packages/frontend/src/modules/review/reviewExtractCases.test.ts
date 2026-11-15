import { describe, it, expect } from "vitest";
import { extractReviewCards, cardBody, planCardPlacements } from "./reviewExtract";

// 抓題 (⑥): the Q/A carve rule + cardBody back-link + 立體化 grid placement.
// Pure functions, so the rules are pinned here apart from the API orchestration
// in useOverviewMode.extractCardsFromSelectedNote.

describe("extractReviewCards", () => {
  it("pairs a single Q:/A: into one card", () => {
    const cards = extractReviewCards("Q: capital of France\nA: Paris");
    expect(cards).toEqual([{ question: "capital of France", answer: "Paris" }]);
  });

  it("extracts multiple cards in document order", () => {
    const cards = extractReviewCards("Q: one\nA: first\nQ: two\nA: second");
    expect(cards).toEqual([
      { question: "one", answer: "first" },
      { question: "two", answer: "second" },
    ]);
  });

  it("drops an orphan Q with no A (a card with no back is not a card)", () => {
    const cards = extractReviewCards("Q: lonely question\nQ: real\nA: answer");
    expect(cards).toEqual([{ question: "real", answer: "answer" }]);
  });

  it("drops a trailing orphan Q at EOF", () => {
    const cards = extractReviewCards("Q: answered\nA: yes\nQ: dangling");
    expect(cards).toEqual([{ question: "answered", answer: "yes" }]);
  });

  it("collapses a multi-line question (lines between Q: and A:) into one", () => {
    const cards = extractReviewCards("Q: first part\nstill the question\nA: the answer");
    expect(cards[0].question).toBe("first part still the question");
  });

  it("keeps a multi-line answer verbatim until the next terminator", () => {
    const cards = extractReviewCards("Q: q\nA: line one\nline two\n\nline three\nQ: q2\nA: a2");
    expect(cards[0].answer).toBe("line one\nline two\n\nline three");
    expect(cards[1]).toEqual({ question: "q2", answer: "a2" });
  });

  it("ends an answer at a markdown heading", () => {
    const cards = extractReviewCards("Q: q\nA: the answer\n## New Section\nnot the answer");
    expect(cards).toEqual([{ question: "q", answer: "the answer" }]);
  });

  it("ends an answer at a thematic break (---)", () => {
    const cards = extractReviewCards("Q: q\nA: the answer\n---\ntrailing");
    expect(cards[0].answer).toBe("the answer");
  });

  it("accepts full-width colons (Q：/A：) and is case-insensitive", () => {
    const cards = extractReviewCards("q： 問題\na： 答案");
    expect(cards).toEqual([{ question: "問題", answer: "答案" }]);
  });

  it("treats Q:/A: inside a fenced code block as opaque content, not card boundaries", () => {
    const md = "Q: explain this snippet\nA: it loops\n```\nQ: not a card\nA: still content\n```\nmore answer";
    const cards = extractReviewCards(md);
    expect(cards).toHaveLength(1);
    expect(cards[0].question).toBe("explain this snippet");
    // the fenced block (and the line after it) stay in the one answer
    expect(cards[0].answer).toContain("```");
    expect(cards[0].answer).toContain("Q: not a card");
    expect(cards[0].answer).toContain("more answer");
  });

  it("supports ~~~ fences too", () => {
    const md = "Q: q\nA: a\n~~~\nQ: fenced\n~~~";
    expect(extractReviewCards(md)).toHaveLength(1);
  });

  it("returns [] for prose with no Q/A markers", () => {
    expect(extractReviewCards("just some lecture notes\nwith no questions")).toEqual([]);
  });

  it("ignores an A: with no preceding Q:", () => {
    expect(extractReviewCards("A: answer with no question")).toEqual([]);
  });

  it("does not treat a second A: line as a new answer — it is answer body", () => {
    const cards = extractReviewCards("Q: q\nA: first\nA: this stays in the answer");
    expect(cards[0].answer).toBe("first\nA: this stays in the answer");
  });
});

describe("cardBody", () => {
  it("appends a wikilink back to the lecture", () => {
    expect(cardBody({ question: "q", answer: "Paris" }, "Geography 101"))
      .toBe("Paris\n\n— [[Geography 101]]\n");
  });

  it("omits the back-link when there is no lecture title", () => {
    expect(cardBody({ question: "q", answer: "Paris" }, "")).toBe("Paris\n");
  });
});

describe("planCardPlacements (立體化 grid)", () => {
  const anchor = { nodeId: "lecture", x: 100, y: 200, width: 240 };

  it("lays fresh cards in a two-column grid to the right of the anchor", () => {
    const out = planCardPlacements([anchor], "lecture", ["c1", "c2", "c3"]);
    // baseX = anchor.x(100) + width(240) + gap(80) = 420
    expect(out[0]).toMatchObject({ nodeId: "c1", x: 420, y: 200 });
    expect(out[1]).toMatchObject({ nodeId: "c2", x: 700, y: 200 }); // +280 column pitch
    expect(out[2]).toMatchObject({ nodeId: "c3", x: 420, y: 350 }); // wraps, +150 row
  });

  it("skips cards already on the board (idempotent re-extract)", () => {
    const out = planCardPlacements([anchor, { nodeId: "c1", x: 0, y: 0 }], "lecture", ["c1", "c2"]);
    expect(out.map((e) => e.nodeId)).toEqual(["c2"]);
    // c2 is the first FRESH card, so it takes the first grid slot
    expect(out[0]).toMatchObject({ x: 420, y: 200 });
  });

  it("falls back to a default origin when the anchor is not on the board", () => {
    const out = planCardPlacements([], "missing", ["c1"]);
    // baseX = 80 + CARD_W(240) + 80 = 400, baseY = 80
    expect(out[0]).toMatchObject({ nodeId: "c1", x: 400, y: 80, width: 240 });
  });

  it("returns [] when every card is already placed", () => {
    expect(planCardPlacements([{ nodeId: "c1", x: 0, y: 0 }], "lecture", ["c1"])).toEqual([]);
  });
});
