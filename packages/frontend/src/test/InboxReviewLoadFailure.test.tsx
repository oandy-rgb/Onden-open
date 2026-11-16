// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import InboxReview from "../components/InboxReview";
import type { InboxEvent } from "../lib/api";
import { ApiError } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";
import { ownerData } from "./ownerData";

const h = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("../lib/data", async (original) => {
  const real = await original<typeof import("../lib/data")>();
  return { ...real, reads: { ...real.reads, events: { ...real.reads.events, preview: h.preview } } };
});

const edit: InboxEvent = {
  id: "20", actor_type: "ai_agent", actor_id: "a", actor_name: "Helper", event_type: "NODE_UPDATED",
  target_type: "node", target_id: "n", payload: { title: "Plan" }, created_at: new Date().toISOString(),
  external: false, restorable: true,
};
const base = { busyId: null, online: true, onApprove: () => {}, onReject: () => {}, showFailedJobs: false };

beforeEach(() => { h.preview.mockReset(); setLocalePref("en"); resetAppState({ data: ownerData }); });
afterEach(() => { cleanup(); setLocalePref("system"); });

describe("InboxReview load failures", () => {
  it("a change whose preview failed to load says so and can retry, instead of 'loading change…' forever", async () => {
    h.preview.mockRejectedValueOnce(new Error("boom: 500"));
    render(<InboxReview {...base} events={[edit]} />);
    expect(await screen.findByText(/Couldn't load this change/)).toBeVisible();
    expect(screen.queryByText("loading change…")).toBeNull();
    expect(document.body.textContent).not.toMatch(/boom/);
    h.preview.mockResolvedValueOnce({ preview: { kind: "node_update", current_body: "b", restored_body: "a", can_apply_cleanly: true } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Text changed")).toBeVisible();
  });

  it("a change whose target is gone says so, without a Try again that can never work", async () => {
    h.preview.mockRejectedValueOnce(new ApiError(404, JSON.stringify({ error: "not_found" })));
    render(<InboxReview {...base} events={[edit]} />);
    expect(await screen.findByText("This note is no longer there.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByText(/Couldn't load this change/)).toBeNull();
  });
});
