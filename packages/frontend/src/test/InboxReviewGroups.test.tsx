// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import InboxReview from "../components/InboxReview";
import type { InboxFilters } from "../lib/inboxFilters";
import { noWorkspaceData, type InboxEvent, type InboxFacets, type InboxGroup, type PendingApproval } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { ownerData } from "./ownerData";

// Inbox batch grouping + filter bar: a grouped card collapses a triggered_by
// chain into one decision surface; the filter chips render the server facet
// counts. Module sections (the RSS strip) are tested with their module.

beforeEach(() => { resetAppState({ data: ownerData }); }); // reviewing needs more than the app's no-data default
afterEach(() => { vi.restoreAllMocks(); });

const ev = (id: string, type: string, title: string, root: string): InboxEvent => ({
  id, actor_type: "ai_agent", actor_id: "rss-actor", actor_name: "RSS",
  event_type: type, target_type: "node", target_id: `node-${id}`,
  payload: { title }, created_at: new Date().toISOString(),
  external: false, restorable: true, root_event_id: root,
});

const baseEvents: InboxEvent[] = [
  ev("10", "AGENT_BATCH", "Probe batch", "10"),
  ev("11", "NODE_CREATED", "Article one", "10"),
  ev("12", "NODE_CREATED", "Article two", "10"),
  ev("20", "NODE_UPDATED", "A lone agent edit", "20"),
];

const group: InboxGroup = {
  root_event_id: "10",
  count: 3,
  sample_titles: ["Article one", "Article two"],
  actor_id: "rss-actor",
  actor_name: "RSS",
  event_ids: ["10", "11", "12"],
  latest_created_at: new Date().toISOString(),
  root_event: {
    id: "10", event_type: "AGENT_BATCH", target_type: "node", target_id: "src-1",
    payload: { title: "Probe batch", count: 2 },
    created_at: new Date().toISOString(),
  },
};

const facets: InboxFacets = {
  by_actor: [
    { actor_id: "rss-actor", actor_name: "RSS", count: 3 },
    { actor_id: "other-agent", actor_name: "Helper", count: 1 },
  ],
  by_type: [
    { event_type: "NODE_CREATED", count: 2 },
    { event_type: "AGENT_BATCH", count: 1 },
    { event_type: "NODE_UPDATED", count: 1 },
  ],
};

function renderInbox(overrides: Partial<Parameters<typeof InboxReview>[0]> = {}) {
  const onGroupDecide = vi.fn();
  const onFiltersChange = vi.fn();
  const filters: InboxFilters = { actorId: null, eventType: null };
  render(
    <InboxReview
      events={baseEvents}
      groups={[group]}
      facets={facets}
      filters={filters}
      onFiltersChange={onFiltersChange}
      busyId={null}
      online
      onApprove={() => {}}
      onReject={() => {}}
      onGroupDecide={onGroupDecide}
      {...overrides}
    />,
  );
  return { onGroupDecide, onFiltersChange };
}

describe("InboxReview — batch grouping", () => {
  it("collapses a chain into ONE batch card; members don't render as single cards", () => {
    renderInbox();
    expect(screen.getByText(/RSS: 3 related changes/)).toBeInTheDocument();
    // The grouped member events are hidden behind the card…
    expect(screen.queryByText(/“Article one”/)).not.toBeInTheDocument();
    // …while the ungrouped single still renders as its own card.
    expect(screen.getByText(/A lone agent edit/)).toBeInTheDocument();
  });

  it("expands to the member list and decides the whole batch", async () => {
    const user = userEvent.setup();
    const { onGroupDecide } = renderInbox();
    await user.click(screen.getByText(/Article one · Article two/));
    expect(screen.getByText("Article one")).toBeInTheDocument();
    expect(screen.getByText("Article two")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Approve all/ }));
    expect(onGroupDecide).toHaveBeenCalledWith("10", "approve");
    await user.click(screen.getByRole("button", { name: /Dismiss all/ }));
    expect(onGroupDecide).toHaveBeenCalledWith("10", "reject");
  });

  it("without onGroupDecide (host not wired) every event renders individually", () => {
    renderInbox({ onGroupDecide: undefined });
    expect(screen.queryByText(/RSS: 3 related changes/)).not.toBeInTheDocument();
    expect(screen.getByText(/Article one/)).toBeInTheDocument();
  });
});

describe("InboxReview — a deck change", () => {
  it("says the slides changed, not the attribute's name", () => {
    const change = { ...ev("30", "ATTRIBUTE_SET", "My talk", "30"), payload: { title: "My talk", key: "slides_data", value: '{"theme":"paper"}' } };
    renderInbox({ events: [change], groups: [] });
    expect(screen.getByText("Slides changed")).toBeInTheDocument();
    expect(screen.queryByText(/slides_data/)).not.toBeInTheDocument();
    expect(screen.queryByText(/theme/)).not.toBeInTheDocument();
  });
});

describe("InboxReview — filter bar", () => {
  it("renders actor chips with facet counts and toggles the actor filter", async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = renderInbox();
    const chip = screen.getByRole("button", { name: /RSS 3/ });
    expect(chip).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Helper 1/ })).toBeInTheDocument();
    await user.click(chip);
    expect(onFiltersChange).toHaveBeenCalledWith({ actorId: "rss-actor", eventType: null });
  });

  it("type dropdown narrows by event_type; clear resets both filters", async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = renderInbox({ filters: { actorId: "rss-actor", eventType: null } });
    await user.selectOptions(screen.getByRole("combobox"), "NODE_CREATED");
    expect(onFiltersChange).toHaveBeenCalledWith({ actorId: "rss-actor", eventType: "NODE_CREATED" });
    await user.click(screen.getByRole("button", { name: /clear/ }));
    expect(onFiltersChange).toHaveBeenCalledWith({ actorId: null, eventType: null });
  });

  it("an active filter with zero results still shows the bar + an empty note (so it can be cleared)", () => {
    renderInbox({ events: [], groups: [], filters: { actorId: "other-agent", eventType: null } });
    expect(screen.getByText(/Nothing matches these filters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear/ })).toBeInTheDocument();
  });
});

// D77: deciding is gated on the bootstrap's can_review (backend
// reviewAuthority) — a viewer reads the queue but gets no buttons that would
// only answer 403.
describe("InboxReview — who may decide", () => {
  afterEach(() => { resetAppState(); });
  const held: PendingApproval = {
    id: "7", effect_kind: "tag_pack", payload: { pack: { name: "books", fields: [] } },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const decisionButtons = () => screen.queryAllByRole("button", { name: /Approve|Reject|Dismiss all|Undo/ });

  it("a member who cannot review sees the queue without Approve / Reject, and why", () => {
    resetAppState({ data: { ...noWorkspaceData, actor_role: "viewer", actor_is_owner: false, can_review: false } });
    renderInbox({ approvals: [held], onBatchDecide: vi.fn() });
    expect(screen.getByText(/RSS: 3 related changes/)).toBeInTheDocument();
    expect(screen.getByText(/A lone agent edit/)).toBeInTheDocument();
    expect(decisionButtons()).toEqual([]);
    expect(screen.getByText(/Only the workspace owner or a reviewer can approve or reject/)).toBeInTheDocument();
  });

  it("a reviewer gets the buttons", () => {
    resetAppState({ data: { ...noWorkspaceData, actor_role: "reviewer", actor_is_owner: false, can_review: true } });
    renderInbox({ approvals: [held] });
    expect(screen.getByRole("button", { name: /Approve all/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve & run/ })).toBeInTheDocument();
    expect(screen.queryByText(/Only the workspace owner or a reviewer/)).not.toBeInTheDocument();
  });
});

// An AI's suggestion on the review card: plain words and the note's title, never the event code.
describe("the review card of an AI suggestion", () => {
  it("names the note by its current title and says what the AI did in plain words", async () => {
    const { setLocalePref } = await import("../lib/i18n");
    setLocalePref("zh-TW");
    try {
      resetAppState({ data: { ...ownerData, nodes: [...ownerData.nodes, { ...ownerData.nodes[0]!, id: "node-30", title: "專題" }] } });
      const suggestion: InboxEvent = { ...ev("30", "AI_SUGGESTION_CREATED", "", "30"), target_id: "node-30", payload: { item_count: 2 }, restorable: false };
      render(<InboxReview events={[suggestion]} busyId={null} online onApprove={vi.fn()} onReject={vi.fn()} />);
      expect(screen.getByText("建議修改")).toBeInTheDocument();
      expect(screen.getByText("“專題”")).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/AI[ _]SUGGESTION|ai suggestion|一篇筆記/i);
    } finally { setLocalePref("en"); }
  });
});
