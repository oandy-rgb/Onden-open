import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SystemStatusSetting from "../settings/SystemStatusSetting";
import FailedJobsNotice from "../components/FailedJobsNotice";
import SettingsModal from "../settings/SettingsModal";
import type { FailedDelivery, FailedDeliveryGroup } from "../hooks/useFailedDeliveries";
import { api } from "../lib/api";
import { addToast, resetAppState, setAppState } from "../lib/appStore";
import { sendWrite } from "../lib/data/onlineWrite";
import { confirmDialog } from "../components/ConfirmDialog";
import type { SettingContext } from "../lib/settingsTypes";

// Settings › About (owner only): outbox deliveries that ran out of
// retries (about a day of attempts), grouped by kind, with 全部重試 /
// 全部清除 per kind and Retry per row (W27). They used to be inbox cards; the
// inbox now has one line pointing here.
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/appStore", async (original) => ({ ...await original<typeof import("../lib/appStore")>(), addToast: vi.fn() }));
vi.mock("../lib/data/onlineWrite", async (original) => ({ ...await original<typeof import("../lib/data/onlineWrite")>(), sendWrite: vi.fn() }));
vi.mock("../components/ConfirmDialog", () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock("../settings/spacesAndMembers", () => ({ default: () => <div>spaces widget</div> }));
vi.mock("../settings/ModulesSetting", () => ({ default: () => <div>modules widget</div> }));

const embed = (id: string): FailedDelivery => ({ id, effect_kind: "embed", attempts: 35, last_error: "embedding provider 401", failed_at: "2026-10-17T00:00:00Z" });
const backup: FailedDelivery = { id: "7", effect_kind: "github_backup", attempts: 35, last_error: "github backup push failed: 503", failed_at: "2026-10-14T00:00:00Z" };
const groups: FailedDeliveryGroup[] = [
  { effect_kind: "embed", count: 120, last_error: "embedding provider 401", oldest_at: "2026-10-15T00:00:00Z", newest_at: "2026-10-17T00:00:00Z" },
  { effect_kind: "github_backup", count: 1, last_error: "github backup push failed: 503", oldest_at: "2026-10-14T00:00:00Z", newest_at: "2026-10-14T00:00:00Z" },
];
const full = { failed: [embed("1"), embed("2"), backup], count: 3, groups, total: 121 };
const empty = { failed: [], count: 0, groups: [], total: 0 };

const ctx: SettingContext = { online: true, onClose: vi.fn(), onImportDone: vi.fn(), onConnect: vi.fn() };
const asOwner = (owner: boolean) => setAppState((s) => ({ online: true, data: { ...s.data, actor_role: owner ? "admin" : "editor", actor_is_owner: owner } }));

beforeEach(() => {
  resetAppState();
  asOwner(true);
  vi.mocked(api).mockReset();
  vi.mocked(sendWrite).mockReset();
  vi.mocked(addToast).mockClear();
  vi.mocked(confirmDialog).mockClear();
});
afterEach(cleanup);

describe("Settings › About", () => {
  it("groups failed jobs by kind with the count, a plain failure sentence and the time span", async () => {
    vi.mocked(api).mockResolvedValue(full);
    render(<SystemStatusSetting ctx={ctx} />);
    const group = (await screen.findByText("Search index")).closest("li")!;
    expect(within(group).getByLabelText("120 failed jobs")).toHaveTextContent("120");
    expect(within(group).getByText(/kept failing after repeated retries/)).toBeInTheDocument();
    expect(screen.queryByText(/embedding provider 401|push failed/)).toBeNull();
    expect(within(group).getByText(/First failed .* · last /)).toBeInTheDocument();
    const other = screen.getByText("GitHub backup").closest("li")!;
    expect(within(other).getByText(/^Failed /)).toBeInTheDocument();
  });

  it("says all is well when nothing failed", async () => {
    vi.mocked(api).mockResolvedValue(empty);
    render(<SystemStatusSetting ctx={ctx} />);
    expect(await screen.findByText("Every background job is running normally.")).toBeInTheDocument();
  });

  it("全部重試 requeues the kind, then reloads", async () => {
    vi.mocked(api).mockResolvedValueOnce(full).mockResolvedValue(empty);
    vi.mocked(sendWrite).mockResolvedValue({ effect_kind: "embed", requeued: 100, merged: 0, superseded: 20 });
    render(<SystemStatusSetting ctx={ctx} />);
    const group = (await screen.findByText("Search index")).closest("li")!;
    fireEvent.click(within(group).getByRole("button", { name: /Retry all/ }));
    await waitFor(() => expect(sendWrite).toHaveBeenCalledWith("POST", "/api/inbox/failed-effects/kinds/embed/retry", "{}"));
    expect(addToast).toHaveBeenCalledWith("Retrying 100 now", "info");
    await waitFor(() => expect(screen.getByText("Every background job is running normally.")).toBeInTheDocument());
  });

  it("全部清除 asks first, then clears only that kind", async () => {
    vi.mocked(api).mockResolvedValueOnce(full).mockResolvedValue({ ...full, groups: [groups[1]], failed: [backup], total: 1 });
    vi.mocked(sendWrite).mockResolvedValue({ effect_kind: "embed", dismissed: 120 });
    render(<SystemStatusSetting ctx={ctx} />);
    const group = (await screen.findByText("Search index")).closest("li")!;
    fireEvent.click(within(group).getByRole("button", { name: /Clear all/ }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledWith(expect.stringMatching(/Clear 120 failed “Search index” jobs/), expect.objectContaining({ danger: true })));
    await waitFor(() => expect(sendWrite).toHaveBeenCalledWith("POST", "/api/inbox/failed-effects/kinds/embed/dismiss", "{}"));
    await waitFor(() => expect(screen.queryByText("Search index")).not.toBeInTheDocument());
    expect(screen.getByText("GitHub backup")).toBeInTheDocument();
  });

  it("全部清除 does nothing when the question is declined", async () => {
    vi.mocked(api).mockResolvedValue(full);
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    render(<SystemStatusSetting ctx={ctx} />);
    const group = (await screen.findByText("Search index")).closest("li")!;
    fireEvent.click(within(group).getByRole("button", { name: /Clear all/ }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(sendWrite).not.toHaveBeenCalled();
  });

  it("lists a kind's rows on demand; Retry requeues one row", async () => {
    vi.mocked(api).mockResolvedValueOnce(full).mockResolvedValue(empty);
    vi.mocked(sendWrite).mockResolvedValue({ id: "7", status: "requeued" });
    render(<SystemStatusSetting ctx={ctx} />);
    const group = (await screen.findByText("GitHub backup")).closest("li")!;
    fireEvent.click(within(group).getByRole("button", { name: /Show 1/ }));
    fireEvent.click(within(group).getByRole("button", { name: /^Retry$/ }));
    await waitFor(() => expect(sendWrite).toHaveBeenCalledWith("POST", "/api/inbox/failed-effects/7/retry", "{}"));
    expect(addToast).toHaveBeenCalledWith("Retrying now", "info");
  });

  it("says when a newer copy already waits instead of resending a row", async () => {
    vi.mocked(api).mockResolvedValue(full);
    vi.mocked(sendWrite).mockResolvedValue({ id: "7", status: "superseded", superseded_by: "9" });
    render(<SystemStatusSetting ctx={ctx} />);
    const group = (await screen.findByText("GitHub backup")).closest("li")!;
    fireEvent.click(within(group).getByRole("button", { name: /Show 1/ }));
    fireEvent.click(within(group).getByRole("button", { name: /^Retry$/ }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/newer copy/), "info"));
  });

  it("does not read the list while offline", () => {
    vi.mocked(api).mockResolvedValue(full);
    render(<SystemStatusSetting ctx={{ ...ctx, online: false }} />);
    expect(api).not.toHaveBeenCalled();
  });

  it("is the owner's alone: no search hit, no request, and the About page does not show it", async () => {
    asOwner(false);
    vi.mocked(api).mockResolvedValue(full);
    render(<SettingsModal online onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} initialTab="about" />);
    expect(screen.getByRole("button", { name: "About Onden" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("Failed background jobs")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings…" }), { target: { value: "failed" } });
    expect(screen.queryByText("Failed background jobs")).toBeNull();
    expect(api).not.toHaveBeenCalledWith("/api/inbox/failed-effects");
  });

  it("the owner finds the failed jobs on the About page", async () => {
    vi.mocked(api).mockResolvedValue(full);
    render(<SettingsModal online onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} initialTab="about" />);
    expect(screen.getByRole("button", { name: "About Onden" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("Search index")).toBeInTheDocument();
  });
});

describe("the failed-jobs notice", () => {
  it("is one line for the owner that opens Settings › About", async () => {
    vi.mocked(api).mockResolvedValue(full);
    const opened = vi.fn();
    window.addEventListener("onden:open-settings", (e) => opened((e as CustomEvent).detail), { once: true });
    render(<FailedJobsNotice online />);
    const line = await screen.findByRole("button", { name: "⚠ 121 background jobs failed → View" });
    expect(screen.queryByText("embedding provider 401")).toBeNull(); // no per-job cards
    fireEvent.click(line);
    expect(opened).toHaveBeenCalledWith("about");
  });

  it("shows nothing when nothing failed, and nothing (no request) for a non-owner", async () => {
    vi.mocked(api).mockResolvedValue(empty);
    const { container, unmount } = render(<FailedJobsNotice online />);
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/inbox/failed-effects"));
    expect(container).toBeEmptyDOMElement();
    unmount();
    vi.mocked(api).mockReset();
    vi.mocked(api).mockResolvedValue(full);
    asOwner(false);
    const other = render(<FailedJobsNotice online />);
    expect(other.container).toBeEmptyDOMElement();
    expect(api).not.toHaveBeenCalled();
  });
});
