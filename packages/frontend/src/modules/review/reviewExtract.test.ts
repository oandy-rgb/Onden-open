import { describe, it, expect } from "vitest";
import { extractReviewCards, cardBody, planCardPlacements } from "./reviewExtract";

describe("extractReviewCards", () => {
  it("extracts Q/A pairs; answers run to the next Q, heading, rule, or EOF", () => {
    const md = [
      "# Mitosis lecture",
      "intro prose",
      "",
      "Q: What are the phases of mitosis?",
      "A: Prophase, metaphase,",
      "anaphase, telophase.",
      "",
      "more prose between cards",
      "",
      "Q: What holds sister chromatids together?",
      "A: Cohesin.",
      "## Next section",
      "Q: Heading-bounded?",
      "A: This answer stops at the rule.",
      "---",
      "trailing prose",
    ].join("\n");
    const cards = extractReviewCards(md);
    expect(cards.map((c) => c.question)).toEqual([
      "What are the phases of mitosis?",
      "What holds sister chromatids together?",
      "Heading-bounded?",
    ]);
    // the answer keeps continuation lines and intervening prose up to its
    // terminator — trimmed at the edges
    expect(cards[0].answer).toBe("Prophase, metaphase,\nanaphase, telophase.\n\nmore prose between cards");
    expect(cards[1].answer).toBe("Cohesin.");
    expect(cards[2].answer).toBe("This answer stops at the rule.");
  });

  it("supports full-width colons and lowercase markers (zh writing habits)", () => {
    const cards = extractReviewCards("Q：粒線體的功能？\na：產生 ATP。");
    expect(cards).toEqual([{ question: "粒線體的功能？", answer: "產生 ATP。" }]);
  });

  it("multi-line questions fold into one line; blank lines between Q and A are neutral", () => {
    const cards = extractReviewCards("Q: A question\nthat wraps lines\n\nA: the answer");
    expect(cards).toEqual([{ question: "A question that wraps lines", answer: "the answer" }]);
  });

  it("a Q with no A is dropped — a card with no back is not a card", () => {
    expect(extractReviewCards("Q: orphan question\n\n## section\nprose")).toEqual([]);
    expect(extractReviewCards("Q: orphan at eof")).toEqual([]);
  });

  it("fenced code is opaque outside answers, verbatim inside them", () => {
    const md = [
      "```",
      "Q: not a card, just code",
      "A: still code",
      "```",
      "Q: What does the snippet print?",
      "A: It prints:",
      "```",
      "Q: hi",
      "```",
    ].join("\n");
    const cards = extractReviewCards(md);
    expect(cards).toHaveLength(1);
    expect(cards[0].question).toBe("What does the snippet print?");
    expect(cards[0].answer).toBe("It prints:\n```\nQ: hi\n```");
  });

  it("no Q/A blocks → empty result (the no-op case the UI toasts about)", () => {
    expect(extractReviewCards("just prose\n\n## heading\nmore prose")).toEqual([]);
    expect(extractReviewCards("")).toEqual([]);
  });

  it("planCardPlacements: two-column grid right of the anchor; already-placed ids skipped", () => {
    const existing = [
      { nodeId: "lecture", x: 100, y: 200, width: 300 },
      { nodeId: "c1", x: 480, y: 200, width: 240 },
    ];
    const out = planCardPlacements(existing, "lecture", ["c1", "c2", "c3", "c4"]);
    // c1 already on the board → only c2..c4 placed
    expect(out.map((e) => e.nodeId)).toEqual(["c2", "c3", "c4"]);
    // base = anchor.x + anchor.width + 80 = 480, anchor.y = 200
    expect(out[0]).toEqual({ nodeId: "c2", x: 480, y: 200, width: 240 });
    expect(out[1]).toEqual({ nodeId: "c3", x: 760, y: 200, width: 240 });
    expect(out[2]).toEqual({ nodeId: "c4", x: 480, y: 350, width: 240 });
  });

  it("planCardPlacements: no anchor on the board → default origin", () => {
    const out = planCardPlacements([], "missing", ["a"]);
    expect(out[0]).toEqual({ nodeId: "a", x: 400, y: 80, width: 240 });
  });

  it("cardBody links back to the lecture", () => {
    expect(cardBody({ question: "q", answer: "ans" }, "Mitosis lecture"))
      .toBe("ans\n\n— [[Mitosis lecture]]\n");
    expect(cardBody({ question: "q", answer: "ans" }, "")).toBe("ans\n");
  });
});
