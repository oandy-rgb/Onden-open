import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

// What waits for the owner's decision is in two places only: the note's own line
// (「有 N 處等你決定」, NoteDecisions) and the inbox page's 「等你決定」 section
// (DecideSection). The old review tab is gone. The sources are the same: the
// agent's changes, held requests (a site publish, a tag pack) and edit conflicts.
// Failed background jobs, new feed articles and hidden notes are not decisions.

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: apiMock }));
vi.mock("../lib/localDb", () => ({ searchNodes: vi.fn(async () => []) }));

import "../modules"; // the registry that says which module supplies the AI feature
import { DecisionsProvider } from "../hooks/DecisionsContext";
import NoteDecisions from "../components/NoteDecisions";
import DecideSection from "../modules/capture/DecideSection";
import CaptureNavIndicator from "../modules/capture/CaptureNavIndicator";
import { noWorkspaceData, type ContentNode, type InboxEvent, type PendingApproval } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import type { SidebarInbox } from "../components/sidebarGroups";

const note = (id: string, title: string, extra: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title, slug: id, markdown: "", node_type: "content", source_type: "manual", ...extra });
const agentEvent = (id: string, target: string): InboxEvent => ({
  id, actor_type: "ai_agent", actor_id: "bot", event_type: "TAG_APPLIED", target_type: "node", target_id: target,
  payload: { title: "Plain note", tag_name: "idea" }, created_at: "2026-10-18T00:00:00Z", external: false, restorable: true,
} as InboxEvent);
const firstPack: PendingApproval = { id: "41", effect_kind: "tag_pack", payload: { pack: { name: "recipes", fields: [{}] } }, created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z" };
const tagPack: PendingApproval = { id: "42", effect_kind: "tag_pack", payload: { pack: { name: "books", fields: [{}, {}] } }, created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z" };
const bodyConflict = (id: number, target: string, regions = 2) => ({
  id, actor_type: "user", actor_id: "u", event_type: "BODY_CONFLICT", target_type: "node", target_id: target,
  payload: { conflicts: Array.from({ length: regions }, (_, i) => ({ incoming: `kept ${i}`, current: `left out ${i}` })), conflict_count: regions },
  created_at: "2026-10-18T00:00:00Z",
});

let conflictFeed: unknown[] = [];
/** The server: 120 failed search-index jobs, 11 new feed articles; conflicts per `conflictFeed`. */
function answer(path: string) {
  if (path.startsWith("/api/inbox/failed-effects")) {
    return { failed: [], count: 1, groups: [{ effect_kind: "embed", count: 120, last_error: "x", oldest_at: "2026-10-15T00:00:00Z", newest_at: "2026-10-17T00:00:00Z" }], total: 120 };
  }
  if (path.startsWith("/api/rss/sources")) return { sources: [{ id: "s1", title: "A Feed", url: null, unseen: 11, last_error: null }], total_unseen: 11 };
  if (path.startsWith("/api/events")) return { events: path.includes("BODY_CONFLICT") ? conflictFeed : [] };
  return {};
}

function seed(owner = true) {
  resetAppState({
    data: {
      ...noWorkspaceData, actor_is_owner: owner, actor_role: owner ? "admin" : "editor", can_review: owner,
      nodes: [note("n1", "Plain note"), note("n2", "Second note"), note("h1", "Tucked away", { hidden: true })],
    },
    online: true,
  });
}

const inboxOf = (over: Partial<SidebarInbox> = {}): SidebarInbox => ({
  events: [], busyId: null, onApprove: vi.fn(), onReject: vi.fn(), ...over,
});
const withDecisions = (inbox: SidebarInbox, ui: ReactNode) => render(<DecisionsProvider inbox={inbox}>{ui}</DecisionsProvider>);

beforeEach(() => { conflictFeed = []; apiMock.mockReset(); apiMock.mockImplementation(async (path: string) => answer(path)); });
afterEach(() => resetAppState());

describe("the note's own line", () => {
  it("says 有 N 處等你決定 for the agent's changes on this note only, and opens the decision in place", async () => {
    seed();
    const inbox = inboxOf({ events: [agentEvent("e1", "n1"), agentEvent("e2", "n1"), agentEvent("e3", "n2")] });
    withDecisions(inbox, <NoteDecisions nodeId="n1" onOpenNode={vi.fn()} />);
    const line = await screen.findByRole("button", { name: "2 things wait for your decision" });
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(line);
    expect(line).toHaveAttribute("aria-expanded", "true");
    const approve = screen.getAllByRole("button", { name: "Approve" });
    expect(approve).toHaveLength(2);
    // The same writer the old review tab used.
    fireEvent.click(approve[0]!);
    expect(inbox.onApprove).toHaveBeenCalledWith("e1");
  });

  it("counts the places a body conflict left both sides' text, and lets the owner decide there", async () => {
    seed();
    conflictFeed = [bodyConflict(7, "n1", 2)];
    withDecisions(inboxOf(), <NoteDecisions nodeId="n1" onOpenNode={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "2 things wait for your decision" }));
    expect(screen.getAllByRole("button", { name: "Use the left-out text" })).toHaveLength(2);
  });

  it("is absent when nothing waits on the note, and outside the provider", async () => {
    seed();
    const { container } = withDecisions(inboxOf({ events: [agentEvent("e3", "n2")] }), <NoteDecisions nodeId="n1" onOpenNode={vi.fn()} />);
    await act(async () => {});
    expect(container.querySelector(".note-decisions")).toBeNull();
    const lone = render(<NoteDecisions nodeId="n1" onOpenNode={vi.fn()} />);
    expect(lone.container).toBeEmptyDOMElement();
  });
});

describe("the inbox's 「等你決定」 section", () => {
  it("lists the notes with something to decide: title, what kind, how many, and opens the note", async () => {
    seed();
    const onOpenNode = vi.fn();
    conflictFeed = [bodyConflict(7, "n2", 1)];
    withDecisions(inboxOf({ events: [agentEvent("e1", "n1"), agentEvent("e2", "n1")] }), <DecideSection onOpenNode={onOpenNode} />);
    const first = await screen.findByRole("button", { name: "Open “Plain note” to decide" });
    expect(within(first).getByText("AI's changes")).toBeInTheDocument();
    expect(within(first).getByText("2 places")).toBeInTheDocument();
    const second = await screen.findByRole("button", { name: "Open “Second note” to decide" });
    expect(within(second).getByText("Paragraphs both of you changed")).toBeInTheDocument();
    expect(within(second).getByText("1 place")).toBeInTheDocument();
    fireEvent.click(first);
    expect(onOpenNode).toHaveBeenCalledWith("n1");
    // Hidden notes and feed articles are not decisions.
    expect(screen.queryByText("Tucked away")).toBeNull();
    expect(screen.queryByText(/A Feed/)).toBeNull();
  });

  it("opening a note from the section asks its line to be open", async () => {
    seed();
    const inbox = inboxOf({ events: [agentEvent("e1", "n1")] });
    withDecisions(inbox, <><DecideSection onOpenNode={vi.fn()} /><NoteDecisions nodeId="n1" onOpenNode={vi.fn()} /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Open “Plain note” to decide" }));
    expect(await screen.findByRole("button", { name: "1 thing waits for your decision" })).toHaveAttribute("aria-expanded", "true");
  });

  it("decides held requests (tag packs) in the section: they belong to no note", async () => {
    seed();
    const inbox = inboxOf({ approvals: [firstPack, tagPack], onDecideHeld: vi.fn() });
    withDecisions(inbox, <DecideSection onOpenNode={vi.fn()} />);
    expect(await screen.findByText("Install tag pack #recipes")).toBeInTheDocument();
    expect(screen.getByText("Install tag pack #books")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Approve & run/ })[0]!);
    expect(inbox.onDecideHeld).toHaveBeenCalledWith("41", "approve");
    expect(screen.getByRole("heading", { name: /Waiting for your decision/ })).toHaveTextContent("2");
  });

  it("shows nothing when nothing waits; the owner still gets the one line about failed jobs", async () => {
    seed();
    withDecisions(inboxOf(), <DecideSection onOpenNode={vi.fn()} />);
    expect(screen.queryByRole("heading", { name: /Waiting for your decision/ })).toBeNull();
    expect(await screen.findByRole("button", { name: /120 background jobs failed/ })).toBeInTheDocument();
    expect(screen.queryByText("A Feed")).toBeNull();
  });

  it("a non-owner makes no request for failed jobs", async () => {
    seed(false);
    withDecisions(inboxOf(), <DecideSection onOpenNode={vi.fn()} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /background jobs failed/ })).toBeNull();
    expect(apiMock).not.toHaveBeenCalledWith("/api/inbox/failed-effects");
  });
});

describe("the mark on the inbox entry", () => {
  it("counts the decisions: 1 change + 2 requests = 3", async () => {
    seed();
    const { container } = withDecisions(inboxOf({ events: [agentEvent("e1", "n1")], approvals: [firstPack, tagPack] }), <CaptureNavIndicator />);
    await act(async () => {});
    expect(within(container).getByLabelText("3 waiting in the inbox")).toHaveTextContent("3");
  });
});

describe("the inbox page when the queue could not be read", () => {
  it("says so with Try again, instead of showing no decisions", async () => {
    seed();
    const onRetryLoad = vi.fn();
    withDecisions(inboxOf({ loadFailed: true, onRetryLoad }), <DecideSection onOpenNode={vi.fn()} />);
    expect(screen.getByText(/Couldn't load the changes waiting for review/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryLoad).toHaveBeenCalledOnce();
  });

  it("keeps showing what did load, with the error above it", async () => {
    seed();
    withDecisions(inboxOf({ events: [agentEvent("e1", "n1")], loadFailed: true, onRetryLoad: vi.fn() }), <DecideSection onOpenNode={vi.fn()} />);
    expect(screen.getByText(/Couldn't load the changes waiting for review/)).toBeVisible();
    expect(screen.getByText("Waiting for your decision")).toBeVisible();
  });

  it("says nothing when the queue loaded", async () => {
    seed();
    withDecisions(inboxOf({ onRetryLoad: vi.fn() }), <DecideSection onOpenNode={vi.fn()} />);
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("says nothing while AI is off: the queue is an AI feature, so its failure is not shown either", async () => {
    seed();
    setAppState((st) => ({ data: { ...st.data, workspace: { ...st.data.workspace, modules: [] } } }));
    withDecisions(inboxOf({ loadFailed: true, onRetryLoad: vi.fn() }), <DecideSection onOpenNode={vi.fn()} />);
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });
});
