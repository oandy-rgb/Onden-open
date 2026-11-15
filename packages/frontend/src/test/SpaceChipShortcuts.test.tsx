import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));

import { api, type ContentNode } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import { refreshSpaces, resetSpacesForTest } from "../lib/spaces";
import { onSettingsRequest, spaceFilterStore } from "../lib/settingsRequest";
import SpaceChip from "../components/SpaceChip";

const apiMock = vi.mocked(api);
const space = (id: string, name: string) => ({ id, name, kind: "shared", is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: true });
const node = { id: "n1", title: "Note", space_id: "lab", node_type: "content" } as unknown as ContentNode;

beforeEach(async () => {
  apiMock.mockReset(); resetSpacesForTest(); resetAppState(); spaceFilterStore.clear();
  setAppState((s) => ({ data: { ...s.data, actor_is_owner: true } }));
  apiMock.mockImplementation(async (path: string) => {
    if (path === "/api/spaces") return { spaces: [space("lab", "Lab"), space("club", "Club")], is_owner: true };
    if (path === "/api/spaces/lab/members") return { members: [{ id: "a", name: "Andy", type: "human", permission: "edit" }, { id: "bot", name: "Claude", type: "agent", permission: "view" }] };
    if (path.startsWith("/api/spaces/move-preview")) {
      return { node_id: "n1", from: { id: "lab", name: "Lab", kind: "shared" }, to: { id: "club", name: "Club", kind: "shared" }, notes: 1,
        gain: [], lose: [{ id: "bot", name: "Claude", type: "agent" }], membership_epoch: "3" };
    }
    return {};
  });
  await refreshSpaces();
});
afterEach(cleanup);

describe("SpaceChip shortcuts to 空間與成員", () => {
  it("「管理這個空間的成員」 opens the page filtered to this note's space", async () => {
    const opened = vi.fn();
    const off = onSettingsRequest(opened);
    render(<SpaceChip node={node} online />);
    fireEvent.click(await screen.findByRole("button", { name: /Lab/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Claude \(AI\)/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Members and permissions" }));
    expect(opened).toHaveBeenCalledWith("spaces");
    expect(spaceFilterStore.get()).toBe("lab");
    off();
  });

  it("a move that an AI helper could not follow names it and links to the target space", async () => {
    const opened = vi.fn();
    const off = onSettingsRequest(opened);
    render(<SpaceChip node={node} online />);
    fireEvent.click(await screen.findByRole("button", { name: /Lab/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(await within(dialog).findByRole("combobox"), { target: { value: "club" } });
    // Picking a space hands over to the shared move confirmation (MoveToSpaceConfirm).
    const confirm = await screen.findByRole("dialog");
    expect(await within(confirm).findByText("Will no longer see it: Claude (AI)")).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Manage who is in Club" }));
    await waitFor(() => expect(spaceFilterStore.get()).toBe("club"));
    expect(opened).toHaveBeenCalledWith("spaces");
    off();
  });
});
