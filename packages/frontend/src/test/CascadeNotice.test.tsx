import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../lib/data/queryCache", () => ({ dedupedGet: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn(async () => ({})) }));

import { dedupedGet } from "../lib/data/queryCache";
import { resetAppState } from "../lib/appStore";
import { ownerData } from "./ownerData";
import InboxReview, { CASCADE_WAIT_HINT_MIN_CHANGES } from "../components/InboxReview";
import type { InboxEvent } from "../lib/api";

const dedupedGetMock = vi.mocked(dedupedGet);

const agentEvent = (id: string): InboxEvent => ({
  id, event_type: "NODE_CREATED", target_type: "node", target_id: `n-${id}`,
  actor_type: "ai_agent", actor_id: "bot", created_at: new Date().toISOString(),
  payload: { title: `Agent note ${id}` }, restorable: true,
} as unknown as InboxEvent);

function renderReview(events: InboxEvent[], extra: { busyId?: string | null; onReject?: (id: string) => void } = {}) {
  return render(
    <InboxReview
      events={events}
      busyId={extra.busyId ?? null}
      online={true}
      onApprove={() => {}}
      onReject={extra.onReject ?? (() => {})}
    />,
  );
}

describe("CascadeNotice (P1 reject blast-radius)", () => {
  beforeEach(() => { dedupedGetMock.mockReset(); resetAppState({ data: ownerData }); });

  it("stays quiet for cascade-free events", async () => {
    dedupedGetMock.mockResolvedValue({ count: 0, truncated: false, events: [] });
    renderReview([agentEvent("1")]);
    await screen.findByText(/Agent note 1/);
    expect(screen.queryByText(/triggered change/)).toBeNull();
  });

  it("shows the count and expands to the touched targets (redacted stays nameless)", async () => {
    dedupedGetMock.mockResolvedValue({
      count: 3, truncated: false,
      events: [
        { id: "21", event_type: "NODE_CREATED", title: "Summary", redacted: false },
        { id: "22", event_type: "NODE_CREATED", title: "Notes", redacted: false },
        { id: "23", event_type: "ATTRIBUTE_SET", title: null, redacted: true },
      ],
    });
    renderReview([agentEvent("2")]);
    const summary = await screen.findByText("reject also restores 3 triggered change(s)");
    fireEvent.click(summary);
    expect(screen.getByText("Summary")).toBeTruthy();
    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.getByText("(restricted item)")).toBeTruthy();
  });

  it("a failed preview fetch never breaks the card (advisory only)", async () => {
    dedupedGetMock.mockRejectedValue(new Error("boom"));
    renderReview([agentEvent("3")]);
    await screen.findByText(/Agent note 3/);
    expect(screen.getByText("Approve")).toBeTruthy(); // card fully usable
  });

  const WAIT_HINT = /may take a few seconds/;
  const preview = (total: number) => ({
    count: 3, total, truncated: true,
    events: [{ id: "21", event_type: "NODE_CREATED", title: "Summary", redacted: false }],
  });

  it("warns about a wait when the whole chain is over the threshold", async () => {
    dedupedGetMock.mockResolvedValue(preview(CASCADE_WAIT_HINT_MIN_CHANGES + 1));
    renderReview([agentEvent("4")]);
    expect(await screen.findByText(WAIT_HINT)).toBeTruthy();
  });

  it("shows no wait hint at the threshold or below", async () => {
    dedupedGetMock.mockResolvedValue(preview(CASCADE_WAIT_HINT_MIN_CHANGES));
    renderReview([agentEvent("5")]);
    await screen.findByText("reject also restores 3 triggered change(s)+");
    expect(screen.queryByText(WAIT_HINT)).toBeNull();
  });

  it("while undoing the button reads Undoing… and a second press sends nothing", async () => {
    dedupedGetMock.mockResolvedValue(preview(500));
    const onReject = vi.fn();
    const props = { events: [agentEvent("6")], online: true, onApprove: () => {}, onReject };
    const view = render(<InboxReview {...props} busyId={null} />);
    fireEvent.click((await screen.findByText("Reject")).closest("button")!);
    expect(onReject).toHaveBeenCalledTimes(1);
    view.rerender(<InboxReview {...props} busyId="6" />);
    const btn = (await screen.findByText("Undoing…")).closest("button")!;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("while approving, Reject keeps its name", async () => {
    dedupedGetMock.mockResolvedValue(preview(500));
    renderReview([agentEvent("7")], { busyId: "7" });
    expect((await screen.findByText("Reject")).closest("button")!.disabled).toBe(true);
    expect(screen.queryByText("Undoing…")).toBeNull();
  });
});
