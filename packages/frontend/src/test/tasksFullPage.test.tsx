import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import BuilderWorkspace from "../components/BuilderWorkspace";
import { noWorkspaceData } from "../lib/api";
import { resetAppState } from "../lib/appStore";
// History rows read the session; the real store keeps a 1 s unmount timer that can outlive the test environment.
vi.mock("../lib/accountSession", () => ({ useAccountSession: () => null }));

// 任務 is a full page: the workspace shows neither the note sidebar nor the
// info panel beside it (hooks/shellNavigation pageLayout).
vi.mock("../modules/tasks/TasksMode", () => ({ default: () => <section className="tasks-mode">tasks page</section> }));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/?view=tasks");
  global.fetch = vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
  resetAppState({ data: { ...noWorkspaceData, nodes: [] }, online: true });
});
afterEach(() => { vi.restoreAllMocks(); resetAppState(); window.history.replaceState(null, "", "/"); });

describe("任務 page layout", () => {
  it("shows no note sidebar and no info panel", async () => {
    const { container } = render(<BuilderWorkspace />);
    // The whole workspace mounts here: under a full parallel run that takes longer than waitFor's 1 s default.
    await waitFor(() => expect(container.querySelector(".workspace-grid")?.classList.contains("full-page")).toBe(true), { timeout: 5000 });
    expect(container.querySelector(".obsidian-sidebar")).toBeNull();
    expect(container.querySelector(".workspace-grid > .overview-activity, .workspace-grid > .node-inspector")).toBeNull();
  });
});
