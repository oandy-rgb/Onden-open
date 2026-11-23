import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReviewPanel from "./ReviewPanel";
import ReviewHomeSection from "./ReviewHomeSection";
import { resetAppState, setMembershipGated } from "../../lib/appStore";

const live = vi.hoisted(() => ({ listeners: new Set<(tick: { kind: "changed"; latest: number }) => void>() }));
vi.mock("../../lib/liveEvents", () => ({
  isLiveConnected: () => false,
  subscribeLiveTicks: (listener: (tick: { kind: "changed"; latest: number }) => void, connection?: (connected: boolean) => void) => {
    live.listeners.add(listener);
    connection?.(false);
    return () => { live.listeners.delete(listener); };
  },
}));

function changed() {
  act(() => { for (const listener of live.listeners) listener({ kind: "changed", latest: 1 }); });
}

// The markdown renderer drags in highlight/katex/mermaid — irrelevant to the
// review flow under test, so stub it to a plain <div>.
vi.mock("../../components/MarkdownRenderer", () => ({
  default: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));

type FetchCall = { url: string; init?: RequestInit };
let calls: FetchCall[] = [];

function mockFetch(responder: (url: string, init?: RequestInit) => unknown) {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(responder(url, init)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const card = (n: number) => ({
  node_id: `node-${n}`,
  title: `Card ${n}`,
  markdown: `body ${n}`,
  state: null,
  next_days: { 1: 1, 2: 3, 3: 6, 4: 15 },
  context: { source_title: null, before: null, after: null },
});

beforeEach(() => { calls = []; live.listeners.clear(); resetAppState(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("ReviewPanel", () => {
  it("hides held cards during membership checks and cannot revive them after revocation", async () => {
    let queued = [card(1)];
    mockFetch(url => url.includes("/queue") ? { cards: queued, total: queued.length } : {});
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await screen.findByText("Card 1");
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    act(() => setMembershipGated(true));
    expect(screen.queryByText("Card 1")).toBeNull();
    expect(screen.queryByText("body 1")).toBeNull();
    await userEvent.keyboard("1");
    expect(calls.some(({ url }) => url.includes("/grade"))).toBe(false);
    queued = [];
    act(() => setMembershipGated(false));
    await screen.findByText(/Nothing to review right now/);
    expect(screen.queryByText("Card 1")).toBeNull();
    expect(calls.filter(({ url }) => url.includes("/queue"))).toHaveLength(2);
  });

  it("discards a queue response started before a membership gate", async () => {
    let finishOld!: (response: Response) => void;
    let reads = 0;
    global.fetch = vi.fn((url: string) => {
      if (url.includes("/queue") && ++reads === 1) return new Promise<Response>(resolve => { finishOld = resolve; });
      return Promise.resolve(new Response(JSON.stringify(url.includes("/queue") ? { cards: [], total: 0 } : {})));
    }) as unknown as typeof fetch;
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await waitFor(() => expect(finishOld).toBeTypeOf("function"));
    act(() => { setMembershipGated(true); setMembershipGated(false); });
    await act(async () => { finishOld(new Response(JSON.stringify({ cards: [card(1)], total: 1 }))); });
    await screen.findByText(/Nothing to review right now/);
    expect(screen.queryByText("Card 1")).toBeNull();
    expect(reads).toBe(2);
  });

  it("removes a held card when a live module, membership or deletion change excludes it from the server queue", async () => {
    let queued = [card(1)];
    mockFetch(url => url.includes("/queue") ? { cards: queued, total: queued.length } : {});
    render(<ReviewPanel online scope={{ kind: "tag", id: "course" }} onOpenNode={() => {}} />);
    await screen.findByText("Card 1");
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    queued = [];
    changed();
    expect(screen.queryByText("body 1")).toBeNull();
    await screen.findByText(/Nothing to review in this scope today/);
    expect(screen.queryByText("Card 1")).toBeNull();
  });

  it("preserves a revealed answer only when revalidation confirms the same card", async () => {
    let finishRead!: (response: Response) => void;
    let reads = 0;
    global.fetch = vi.fn((url: string) => {
      if (url.includes("/queue") && ++reads > 1) return new Promise<Response>(resolve => { finishRead = resolve; });
      return Promise.resolve(new Response(JSON.stringify(url.includes("/queue") ? { cards: [card(1), card(2)], total: 2 } : {})));
    }) as unknown as typeof fetch;
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await screen.findByText("Card 1");
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    changed();
    expect(screen.queryByText("body 1")).toBeNull();
    expect(screen.queryByRole("button", { name: /Good/ })).toBeNull();
    await act(async () => { finishRead(new Response(JSON.stringify({ cards: [card(1), card(2)], total: 2 }))); });
    expect(screen.getByText("body 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Good/ })).toBeEnabled();

    // The next check excludes the current note: no old answer, and the next
    // authorized card still requires an explicit reveal.
    changed();
    expect(screen.queryByText("body 1")).toBeNull();
    await act(async () => { finishRead(new Response(JSON.stringify({ cards: [card(2)], total: 1 }))); });
    expect(screen.getByText("Card 2")).toBeInTheDocument();
    expect(screen.queryByTestId("md")).toBeNull();
    expect(screen.getByRole("button", { name: /Show answer/ })).toBeEnabled();
  });

  it("forgets a revealed answer after a refused queue read, even if a later retry returns the same card", async () => {
    let refuse = false;
    global.fetch = vi.fn(async (url: string) => url.includes("/queue") && refuse
      ? new Response('{"error":"tag not found"}', { status: 404 })
      : new Response(JSON.stringify(url.includes("/queue") ? { cards: [card(1)], total: 1 } : {}))) as unknown as typeof fetch;
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await screen.findByText("Card 1");
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    refuse = true;
    changed();
    await screen.findByText("tag not found");
    expect(screen.queryByText("body 1")).toBeNull();
    refuse = false;
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText("Card 1");
    expect(screen.queryByTestId("md")).toBeNull();
    expect(screen.getByRole("button", { name: /Show answer/ })).toBeEnabled();
  });

  it("revalidates a previously loaded queue on reconnect", async () => {
    let queued = [card(1)];
    mockFetch(url => url.includes("/queue") ? { cards: queued, total: queued.length } : {});
    const { rerender } = render(<ReviewPanel online onOpenNode={() => {}} />);
    await screen.findByText("Card 1");
    rerender(<ReviewPanel online={false} onOpenNode={() => {}} />);
    queued = [];
    rerender(<ReviewPanel online onOpenNode={() => {}} />);
    await screen.findByText(/Nothing to review right now/);
    expect(screen.queryByText("Card 1")).toBeNull();
  });

  it("keeps the session position when its own grade emits a change before the response", async () => {
    let finishGrade!: (response: Response) => void;
    mockFetch(url => url.includes("/queue") ? { cards: [card(1), card(2)], total: 2 } : {});
    const originalFetch = global.fetch;
    global.fetch = vi.fn((url: string, init?: RequestInit) => url.includes("/grade")
      ? new Promise<Response>(resolve => { finishGrade = resolve; }) : originalFetch(url, init)) as unknown as typeof fetch;
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await screen.findByText("Card 1");
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    changed();
    await act(async () => { finishGrade(new Response("{}")); });
    await screen.findByText("Card 2");
    await waitFor(() => expect(calls.filter(({ url }) => url.includes("/queue"))).toHaveLength(2));
    expect(screen.getByText("1 left")).toBeInTheDocument();
    changed();
    await screen.findByText("Card 2");
    expect(screen.queryByText("Card 1")).toBeNull();
    expect(screen.getByText("1 left")).toBeInTheDocument();
  });

  it("retains a body-free same-key confirmation after an uncertain grade leaves the fresh queue", async () => {
    let rejectGrade!: (error: Error) => void;
    let queued = [card(1), card(2)];
    const grades: RequestInit[] = [];
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/grade")) {
        grades.push(init!);
        if (grades.length === 1) return new Promise<Response>((_, reject) => { rejectGrade = reject; });
        return Promise.resolve(new Response('{"deduped":true}'));
      }
      return Promise.resolve(new Response(JSON.stringify(url.includes("/queue") ? { cards: queued, total: queued.length } : {})));
    }) as unknown as typeof fetch;
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await screen.findByText("Card 1");
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    queued = [card(2)];
    changed();
    await act(async () => { rejectGrade(new TypeError("Failed to fetch")); });
    await screen.findByText(/Retry the same button/);
    await waitFor(() => expect(screen.queryByText("Card 1")).toBeNull());
    expect(screen.queryByText("body 1")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    await screen.findByText("Card 2");
    expect(grades).toHaveLength(2);
    expect(new Headers(grades[1].headers).get("Idempotency-Key")).toBe(new Headers(grades[0].headers).get("Idempotency-Key"));
  });

  it("keeps old card content hidden when revalidation is refused", async () => {
    let refuse = false;
    global.fetch = vi.fn(async (url: string) => url.includes("/queue") && refuse
      ? new Response('{"error":"tag not found"}', { status: 404 })
      : new Response(JSON.stringify(url.includes("/queue") ? { cards: [card(1)], total: 1 } : {}))) as unknown as typeof fetch;
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await screen.findByText("Card 1");
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    refuse = true;
    changed();
    await screen.findByText("tag not found");
    expect(screen.queryByText("Card 1")).toBeNull();
    expect(screen.queryByText("body 1")).toBeNull();
  });

  it("uses tag scope and resets the answer/session when switching tags", async () => {
    mockFetch((url) => url.includes("tag_id=course-a") ? { cards: [card(1)], total: 1 }
      : url.includes("tag_id=course-b") ? { cards: [card(2)], total: 1 } : {});
    const { rerender } = render(<ReviewPanel online scope={{ kind: "tag", id: "course-a" }} onOpenNode={() => {}} />);
    await screen.findByText("Card 1");
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    expect(screen.getByTestId("md")).toHaveTextContent("body 1");
    rerender(<ReviewPanel online scope={{ kind: "tag", id: "course-b" }} onOpenNode={() => {}} />);
    expect(screen.queryByText("Card 1")).toBeNull();
    await screen.findByText("Card 2");
    expect(screen.queryByTestId("md")).toBeNull();
    expect(calls.filter(({ url }) => url.includes("/queue")).map(({ url }) => url)).toEqual([
      "/api/review/queue?tag_id=course-a", "/api/review/queue?tag_id=course-b",
    ]);
  });

  it("ignores a late old-tag queue after the user opens another tag", async () => {
    let finishOld!: (value: Response) => void;
    global.fetch = vi.fn((url: string) => {
      if (url.includes("tag_id=old")) return new Promise<Response>((resolve) => { finishOld = resolve; });
      return Promise.resolve(new Response(JSON.stringify(url.includes("/queue") ? { cards: [card(2)], total: 1 } : {}), { status: 200 }));
    }) as unknown as typeof fetch;
    const { rerender } = render(<ReviewPanel online scope={{ kind: "tag", id: "old" }} onOpenNode={() => {}} />);
    await waitFor(() => expect(finishOld).toBeTypeOf("function"));
    rerender(<ReviewPanel online scope={{ kind: "tag", id: "new" }} onOpenNode={() => {}} />);
    await screen.findByText("Card 2");
    finishOld(new Response(JSON.stringify({ cards: [card(1)], total: 1 }), { status: 200 }));
    await waitFor(() => expect(screen.getByText("Card 2")).toBeInTheDocument());
    expect(screen.queryByText("Card 1")).toBeNull();
  });

  it("loads the queue and shows the first card front-side-up, the back gated behind reveal", async () => {
    mockFetch((url) => url.includes("/queue") ? { cards: [card(1), card(2)], total: 2 } : {});
    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());
    expect(screen.getByText("2 left")).toBeInTheDocument();
    // Back (note body) and grade buttons are hidden until revealed.
    expect(screen.queryByTestId("md")).not.toBeInTheDocument();
    for (const label of ["Again", "Hard", "Good", "Easy"]) {
      expect(screen.queryByRole("button", { name: new RegExp(label) })).not.toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /Show answer/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    expect(screen.getByTestId("md")).toHaveTextContent("body 1");
    for (const label of ["Again", "Hard", "Good", "Easy"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("recovers on reconnect after an offline-at-open queue load failure (L7)", async () => {
    const seen: string[] = [];
    let failNext = true;
    global.fetch = vi.fn(async (url: string) => {
      seen.push(url);
      if (url.includes("/queue") && failNext) { failNext = false; throw new TypeError("Failed to fetch"); }
      return new Response(JSON.stringify({ cards: [card(1)], total: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const { rerender } = render(<ReviewPanel online={false} onClose={() => {}} onOpenNode={() => {}} />);
    // Offline-at-open: the queue fetch fails, so no card loads.
    await waitFor(() => expect(seen.some((u) => u.includes("/queue"))).toBe(true));
    expect(screen.queryByText("Card 1")).not.toBeInTheDocument();

    // Reconnect WITHOUT a remount: the panel must re-fetch and recover.
    rerender(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());
  });

  it("grading (after reveal) posts the rating and advances to the next card front-side-up", async () => {
    mockFetch((url) => url.includes("/queue") ? { cards: [card(1), card(2)], total: 2 } : { ok: true });
    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    await waitFor(() => expect(screen.getByText("Card 2")).toBeInTheDocument());
    expect(screen.getByText("1 left")).toBeInTheDocument();
    // The next card greets us gated again — no answer leaked across the advance.
    expect(screen.queryByTestId("md")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show answer/ })).toBeInTheDocument();

    const gradeCall = calls.find((c) => c.url.includes("/api/review/node-1/grade"));
    expect(gradeCall).toBeTruthy();
    expect(JSON.parse(gradeCall!.init!.body as string)).toEqual({ rating: 3, seen_reps: 0 }); // a new card: the version the client saw
  });

  it("block cards of one note are separate cards, graded on the block route (B3)", async () => {
    const blockCard = (id: string, front: string, back: string) => ({ ...card(0), node_id: "note-1", title: front, markdown: back, block: { id, ref: id } });
    mockFetch((url) => url.includes("/queue") ? { cards: [blockCard("b1", "Q one", "A one"), blockCard("b2", "Q two", "")], total: 2 } : { ok: true });
    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await screen.findByText("Q one");
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    expect(document.querySelector(".review-card-body")).toHaveTextContent("A one");
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    // Same note, next block: it is a card of its own, not "already done".
    await screen.findByText("Q two");
    expect(calls.some((c) => c.url.includes("/api/review/blocks/b1/grade"))).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    expect(screen.getByText("No answer written under this card.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo last grade" }));
    expect(calls.some((c) => c.url.includes("/api/review/blocks/b1/undo-grade"))).toBe(true);
  });

  it("a paragraph card's front is rendered note text and its back stays hidden until revealed", async () => {
    const front = "規則區有 `if` 和 **ID**。各匹配哪條？";
    const oneLine = { ...card(0), node_id: "note-1", title: front, markdown: "`if` 匹配 `\"if\"`", block: { id: "b1", ref: "b1" },
      context: { source_title: "Lex教學", before: "上一題？", after: "下一題？" } };
    mockFetch((url) => url.includes("/queue") ? { cards: [oneLine], total: 1 } : { ok: true });
    const { container } = render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    const head = await waitFor(() => { const el = container.querySelector(".review-card-front"); expect(el).not.toBeNull(); return el!; });
    // The front goes through the note renderer (stubbed in this file as the "md" test id): the text reaches it as written.
    expect(head).toHaveTextContent("各匹配哪條？");
    // Nothing of the answer before the reveal, nor the context (it holds the neighbours).
    expect(screen.queryByText(/匹配 `/)).toBeNull();
    expect(container.querySelector(".review-context")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    expect(container.querySelector(".review-card-body")).toHaveTextContent("匹配");
    expect(container.querySelector('.review-context-near[data-side="after"]')).toHaveTextContent("下一題？");
  });

  it("undo last grade steps that grade back and puts the card at the front again (W25)", async () => {
    mockFetch((url) => url.includes("/queue") ? { cards: [card(1), card(2)], total: 2 } : { ok: true });
    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Undo last grade" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    await waitFor(() => expect(screen.getByText("Card 2")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Undo last grade" }));
    expect(calls.some((c) => c.url.includes("/api/review/node-1/undo-grade") && c.init?.method === "POST")).toBe(true);
    // The queue re-reads and the undone card leads again, front-side-up.
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());
    expect(screen.getByText("2 left")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show answer/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo last grade" })).toBeNull(); // one step back only
  });

  it("grade carries the reps the card was shown with, and undo the reps that grade produced", async () => {
    const seen = { ...card(1), state: { due: "2026-01-01T00:00:00Z", stability: 3, difficulty: 5, reps: 4, lapses: 0, state: "review", last_review: "2025-12-01T00:00:00Z" } };
    mockFetch((url) => url.includes("/queue") ? { cards: [seen, card(2)], total: 2 } : { ok: true });
    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    await waitFor(() => expect(screen.getByText("Card 2")).toBeInTheDocument());
    expect(JSON.parse(calls.find((c) => c.url.includes("/node-1/grade"))!.init!.body as string)).toEqual({ rating: 3, seen_reps: 4 });
    await userEvent.click(screen.getByRole("button", { name: "Undo last grade" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/node-1/undo-grade"))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.includes("/node-1/undo-grade"))!.init!.body as string)).toEqual({ graded_reps: 5 });
  });

  it("undo names the grade by the id the grade answer gave, not only by reps", async () => {
    mockFetch((url) => url.includes("/queue") ? { cards: [card(1), card(2)], total: 2 } : url.includes("/node-1/grade") ? { ok: true, grade_id: "11111111-1111-4111-8111-111111111111" } : { ok: true });
    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    await waitFor(() => expect(screen.getByText("Card 2")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Undo last grade" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/node-1/undo-grade"))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.includes("/node-1/undo-grade"))!.init!.body as string))
      .toEqual({ graded_reps: 1, graded_id: "11111111-1111-4111-8111-111111111111" });
  });

  it("an undo refused because another device graded since keeps that grade and refreshes the queue", async () => {
    let queueReads = 0;
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes("/queue")) { queueReads += 1; return new Response(JSON.stringify({ cards: [card(1), card(2)], total: 2 }), { status: 200 }); }
      if (url.includes("/undo-grade")) return new Response(JSON.stringify({ error: "card changed since it was graded" }), { status: 409 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    await waitFor(() => expect(screen.getByText("Card 2")).toBeInTheDocument());
    const readsBefore = queueReads;
    await userEvent.click(screen.getByRole("button", { name: "Undo last grade" }));
    await screen.findByText("This card was graded again elsewhere, so it was not undone.");
    expect(screen.queryByText(/changed since/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo last grade" })).toBeNull();
    await waitFor(() => expect(queueReads).toBeGreaterThan(readsBefore));
  });

  it("an unconfirmed undo retries with its original key, so it steps back only once (W25 review)", async () => {
    const undoCalls: RequestInit[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/queue")) return new Response(JSON.stringify({ cards: [card(1), card(2)], total: 2 }), { status: 200 });
      if (url.includes("/undo-grade")) {
        undoCalls.push(init!);
        if (undoCalls.length === 1) throw new TypeError("Failed to fetch"); // the response is lost
        return new Response(JSON.stringify({ deduped: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    await waitFor(() => expect(screen.getByText("Card 2")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Undo last grade" }));
    await screen.findByText("Could not confirm the undo. Try again to finish.");
    await userEvent.click(screen.getByRole("button", { name: "Undo last grade" }));
    await waitFor(() => expect(undoCalls).toHaveLength(2));
    const keys = undoCalls.map((init) => new Headers(init.headers).get("Idempotency-Key"));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo last grade" })).toBeNull());
  });

  it("a retried undo answered 409 'nothing to undo' counts as done: the first attempt landed (W25 follow-up)", async () => {
    let undos = 0;
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes("/queue")) return new Response(JSON.stringify({ cards: [card(1), card(2)], total: 2 }), { status: 200 });
      if (url.includes("/undo-grade")) {
        undos += 1;
        if (undos === 1) throw new TypeError("Failed to fetch"); // landed, but the reply was lost
        return new Response(JSON.stringify({ error: "nothing to undo" }), { status: 409 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    await waitFor(() => expect(screen.getByText("Card 2")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Undo last grade" }));
    await screen.findByText("Could not confirm the undo. Try again to finish.");
    await userEvent.click(screen.getByRole("button", { name: "Undo last grade" }));
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());
    expect(screen.queryByText(/nothing to undo/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo last grade" })).toBeNull();
  });

  it("keeps an uncertain grade on the same card and retries with its original key", async () => {
    const gradeCalls: RequestInit[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/queue")) {
        return new Response(JSON.stringify({ cards: [card(1)], total: 1 }), { status: 200 });
      }
      if (url.includes("/grade")) {
        gradeCalls.push(init!);
        if (gradeCalls.length === 1) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ deduped: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    await waitFor(() => expect(screen.getByText(/Retry the same button/)).toBeInTheDocument());
    expect(screen.getByText("Card 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hard/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Good/ })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    await waitFor(() => expect(screen.getByText(/Done — 1 reviewed/)).toBeInTheDocument());
    expect(gradeCalls).toHaveLength(2);
    const keys = gradeCalls.map((init) => new Headers(init.headers).get("Idempotency-Key"));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(keys[1]).toBe(keys[0]);
  });

  it("releases a rejected grade so the user can choose again with a new key", async () => {
    const gradeCalls: RequestInit[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/queue")) {
        return new Response(JSON.stringify({ cards: [card(1)], total: 1 }), { status: 200 });
      }
      if (url.includes("/grade")) {
        gradeCalls.push(init!);
        return gradeCalls.length === 1
          ? new Response('{"error":"forbidden"}', { status: 403 })
          : new Response('{"node_id":"node-1"}', { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    await waitFor(() => expect(screen.getByText(/permission/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Hard/ })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /Hard/ }));
    await waitFor(() => expect(screen.getByText(/Done — 1 reviewed/)).toBeInTheDocument());
    const keys = gradeCalls.map((init) => new Headers(init.headers).get("Idempotency-Key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("keyboard 1–4 does nothing until revealed; Space reveals, then 1–4 grades", async () => {
    mockFetch((url) => url.includes("/queue") ? { cards: [card(1)], total: 1 } : { ok: true });
    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());

    // Pressing a grade key before reveal must not submit a grade.
    await userEvent.keyboard("1");
    expect(calls.find((c) => c.url.includes("/grade"))).toBeUndefined();

    await userEvent.keyboard(" ");
    expect(screen.getByTestId("md")).toHaveTextContent("body 1");

    await userEvent.keyboard("1");
    await waitFor(() => {
      const gradeCall = calls.find((c) => c.url.includes("/api/review/node-1/grade"));
      expect(gradeCall).toBeTruthy();
      expect(JSON.parse(gradeCall!.init!.body as string)).toEqual({ rating: 1, seen_reps: 0 });
    });
  });

  it("finishing the queue shows the done message with the session count", async () => {
    mockFetch((url) => url.includes("/queue") ? { cards: [card(1)], total: 1 } : { ok: true });
    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Card 1")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Easy/ }));
    await waitFor(() => expect(screen.getByText(/Done — 1 reviewed/)).toBeInTheDocument());
  });

  it("an empty queue shows the quiet how-to empty state", async () => {
    mockFetch((url) => url.includes("/queue") ? { cards: [], total: 0 } : {});
    render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Nothing to review right now/)).toBeInTheDocument());
  });

  it("shows how many new cards today's one daily cap still allows, and no separate new-card budget (an older server may still send one)", async () => {
    mockFetch((url) => url.includes("/queue") ? { cards: [], total: 0 }
      : { due: 0, new: 3, learned: 0, new_today: 4, new_per_day: 30, budget_scope: "single", new_available: 3 });
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await screen.findByText("3 new cards available today");
    expect(screen.queryByText("4 of 30 new cards today")).toBeNull();
  });

  it("renders an ink thumbnail for a handwritten card with no markdown body", async () => {
    const inkCard = {
      ...card(0),
      node_id: "node-ink",
      title: "Handwritten card",
      markdown: "",
      ink_data: JSON.stringify({
        version: 1,
        strokes: [{ id: "s1", points: [[10, 10], [40, 40], [80, 20]], color: "#1a1a1a", size: 4, toolId: "pen" }],
        erased: {},
        page: { width: 1000 },
      }),
      state: null,
    };
    mockFetch((url) => url.includes("/queue") ? { cards: [inkCard], total: 1 } : {});
    const { container } = render(<ReviewPanel online onClose={() => {}} onOpenNode={() => {}} />);
    await waitFor(() => expect(screen.getByText("Handwritten card")).toBeInTheDocument());
    // The body (including the ink fallback) stays gated behind reveal, same as
    // a markdown card — reveal first, then assert the strokes render.
    await userEvent.click(screen.getByRole("button", { name: /Show answer/ }));
    // The empty-markdown card falls back to a static SVG of the strokes, not
    // the "This note is empty." placeholder.
    expect(container.querySelector(".review-ink-thumb svg")).toBeTruthy();
    expect(screen.queryByText(/This note is empty/)).not.toBeInTheDocument();
  });

  it("Open jumps to the note and closes the drawer", async () => {
    mockFetch((url) => url.includes("/queue") ? { cards: [card(7)], total: 1 } : {});
    const onOpenNode = vi.fn();
    const onClose = vi.fn();
    render(<ReviewPanel online onClose={onClose} onOpenNode={onOpenNode} />);
    await waitFor(() => expect(screen.getByText("Card 7")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(onOpenNode).toHaveBeenCalledWith("node-7");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ReviewHomeSection", () => {
  it("renders the due line when cards are waiting", async () => {
    mockFetch(() => ({ due: 3, new: 2, learned: 5 }));
    render(<ReviewHomeSection onOpenReview={() => {}} />);
    await waitFor(() => expect(screen.getByText("3 notes ready to review")).toBeInTheDocument());
    expect(screen.getByText("2 new")).toBeInTheDocument();
  });

  it("renders nothing when nothing is due", async () => {
    mockFetch(() => ({ due: 0, new: 0, learned: 5 }));
    const { container } = render(<ReviewHomeSection onOpenReview={() => {}} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("clicking the line opens the review drawer", async () => {
    mockFetch(() => ({ due: 1, new: 0, learned: 0 }));
    const onOpenReview = vi.fn();
    render(<ReviewHomeSection onOpenReview={onOpenReview} />);
    await waitFor(() => expect(screen.getByText("1 note ready to review")).toBeInTheDocument());
    await userEvent.click(screen.getByText("1 note ready to review"));
    expect(onOpenReview).toHaveBeenCalled();
  });
});
