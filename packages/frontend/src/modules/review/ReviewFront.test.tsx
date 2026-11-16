// A paragraph card's front is drawn by the same renderer as its back (no stub here): inline code is a <code>, not
// backticks, and the answer is not in the page until it is revealed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReviewPanel from "./ReviewPanel";
import { resetAppState } from "../../lib/appStore";

vi.mock("../../lib/liveEvents", () => ({ isLiveConnected: () => false, subscribeLiveTicks: () => () => {} }));

const oneLine = {
  node_id: "note-1", title: "規則區有 `if` 和 **ID**。各匹配哪條？", markdown: "答案是 `{ID}`", ink_data: null, state: null,
  next_days: { 1: 1, 2: 3, 3: 6, 4: 15 }, block: { id: "b1", ref: "b1" },
  context: { source_title: "Lex教學", before: "上一題？", after: "下一題？" },
};

beforeEach(() => {
  resetAppState();
  global.fetch = vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("/queue") ? { cards: [oneLine], total: 1 } : {}),
    { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
});

describe("a paragraph card's front", () => {
  it("is rendered: a <code> element and no backticks; the back is not there until revealed", async () => {
    const { container } = render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(container.querySelector(".review-card-front code")).not.toBeNull());
    const front = container.querySelector(".review-card-front")!;
    expect(front.textContent).not.toContain("`");
    expect(front.querySelector("code")).toHaveTextContent("if");
    expect(front.querySelector("strong")).toHaveTextContent("ID");
    expect(screen.queryByText(/答案是/)).toBeNull();
    expect(container.querySelector(".review-context")).toBeNull();
    // Keyboard: the reveal button is a real button that takes focus and Enter.
    const reveal = screen.getByRole("button", { name: /Show answer/ });
    reveal.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText(/答案是/)).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector(".review-card-body code")).toHaveTextContent("{ID}"));
  });
});
