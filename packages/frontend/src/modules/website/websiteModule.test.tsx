// The website as a module: its screen is listed under More → Organize and
// publish (not the primary bar), and its timeline section loads its own
// published snapshots — before, the timeline only showed them after the site
// studio had been opened once. Its Publish… goes through the same preview and
// hash as the Studio, and a failure is reported instead of silently
// re-enabling the button.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiMock = vi.fn();
vi.mock("../../lib/api", async (original) => ({
  ...await original<typeof import("../../lib/api")>(),
  api: (...args: unknown[]) => apiMock(...args),
  postRead: (path: string, body?: unknown, init: RequestInit = {}) => apiMock(path, { ...init, method: "POST", body: JSON.stringify(body) }),
}));
vi.mock("../../lib/localDb", async (original) => ({
  ...await original<typeof import("../../lib/localDb")>(),
  getPendingWrites: vi.fn(async () => []),
}));

import PublishedSnapshots from "./PublishedSnapshots";
import PublishLog from "./PublishLog";
import { MODULE_SCREENS } from "..";
import { ApiError } from "../../lib/api";
import { getAppState, resetAppState } from "../../lib/appStore";

const snap = (id: string) => ({ id, title: "Site", node_count: 3, created_at: "2026-10-06T00:00:00Z", artifact_ref: "https://example.test/site/" });

beforeEach(() => { apiMock.mockReset(); resetAppState({ online: true }); });

describe("website module", () => {
  it("has a screen of its own (a navigation destination while imported)", () => {
    expect(MODULE_SCREENS.has("website")).toBe(true);
  });

  it("the timeline section lists published snapshots on its own", async () => {
    apiMock.mockImplementation(async (path: string) => path === "/api/snapshots" ? [snap("b"), snap("a")] : {});
    render(<PublishedSnapshots online onRefresh={() => {}} />);
    expect(await screen.findByText("#2")).toBeInTheDocument();
    expect(screen.getByText("View Site ↗")).toHaveAttribute("href", "https://example.test/site/");
    // one row = three separate cells, so the columns line up
    const row = screen.getByText("#2").closest(".tl-publish-row")!;
    expect([...row.children].map((el) => el.className)).toEqual(["tl-publish-index", "tl-publish-date", "tl-publish-nodes"]);
    expect(row.querySelector(".tl-publish-nodes")).toHaveTextContent("3");
  });

  it("the website page shows 發布紀錄 with the snapshots and Publish…", async () => {
    apiMock.mockImplementation(async (path: string) => path === "/api/snapshots" ? [snap("b"), snap("a")] : {});
    render(<PublishLog online onRefresh={() => {}} />);
    expect(screen.getByRole("heading", { name: "Publish log" })).toBeInTheDocument();
    expect(await screen.findByText("#2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Publish…/ })).toBeEnabled();
  });

  const preview = {
    hash: "c".repeat(64), site: { title: "Site", home_node_id: null, payload: { nodes: [{ id: "n1", title: "Home", slug: "home" }] } },
    live: null, diff: { added: [{ id: "n1", title: "Home", slug: "home" }], changed: [], moved: [], links_changed: [], removed: [], settings_changed: false },
    private_links: [], blocked_media: [],
  };

  it("Publish… shows the preview first; confirming publishes it by hash, reloads the list and refreshes", async () => {
    let published = false;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/publish/preview") return preview;
      if (path === "/api/publish" && init?.method === "POST") { published = true; return { url: "/site/" }; }
      if (path === "/api/snapshots") return published ? [snap("a")] : [];
      return {};
    });
    const onRefresh = vi.fn();
    render(<PublishedSnapshots online onRefresh={onRefresh} />);
    await userEvent.click(await screen.findByRole("button", { name: /Publish…/ }));
    expect(await screen.findByText("New on the site (1)")).toBeInTheDocument();
    expect(published).toBe(false); // nothing goes out before Confirm
    await userEvent.click(screen.getByRole("button", { name: "Confirm & publish →" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("#1")).toBeInTheDocument();
    const call = apiMock.mock.calls.find(([path]) => path === "/api/publish")!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toMatchObject({ preview_hash: "c".repeat(64) });
    expect(call[1]).toMatchObject({ method: "POST", headers: { "Idempotency-Key": expect.any(String) } });
  });

  it("a failed publish says so", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/publish/preview") return preview;
      if (path === "/api/publish") throw new ApiError(403, JSON.stringify({ error: "forbidden" }));
      return path === "/api/snapshots" ? [] : {};
    });
    const onRefresh = vi.fn();
    render(<PublishedSnapshots online onRefresh={onRefresh} />);
    await userEvent.click(await screen.findByRole("button", { name: /Publish…/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm & publish →" }));
    await waitFor(() => expect(getAppState().toasts.map((toast) => toast.message))
      .toContain("You don't have permission to do that."));
    expect(screen.getByRole("button", { name: /Publish…/ })).toBeEnabled();
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
