import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Settings › Modules › RSS › 訂閱放在: the owner picks the space new
// subscriptions live in. Choosing one that would move subscriptions asks first
// (cancel changes nothing); success shows the new value; others see it read-only.

vi.mock("../../lib/localDb", async (original) => ({ ...await original<typeof import("../../lib/localDb")>(), getPendingWrites: vi.fn(async () => []), upsertWorkspace: vi.fn(async () => {}) }));
vi.mock("../../lib/api", async (original) => ({ ...await original<typeof import("../../lib/api")>(), api: vi.fn() }));
vi.mock("../../lib/spaces", async (original) => ({ ...await original<typeof import("../../lib/spaces")>(), useSpaces: () => ({ spaces: SPACES, loaded: true }) }));

import { api } from "../../lib/api";
import { resetAppState, setAppState } from "../../lib/appStore";
import type { Space } from "../../lib/spaces";
import RssSourceSpaceWidget from "./RssSourceSpaceWidget";

const space = (over: Partial<Space> & Pick<Space, "id" | "name" | "kind">): Space => ({
  is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: over.kind === "shared", ...over,
});
const SPACES: Space[] = [
  space({ id: "mine", name: "Mine", kind: "personal", can_manage: true }),
  space({ id: "team", name: "Team", kind: "shared" }),
  space({ id: "read-only", name: "Reading club", kind: "shared", permission: "view", can_manage: false }),
];

const ctx = { online: true, onClose: () => {}, onImportDone: () => {}, onConnect: () => {} };
const calls: Array<{ path: string; method?: string; body?: string }> = [];

function owner(isOwner: boolean, config: Record<string, unknown> = {}) {
  resetAppState();
  setAppState((s) => ({ data: { ...s.data, actor_is_owner: isOwner, site_config: config } }));
}

let movable = 2;
beforeEach(() => {
  calls.length = 0;
  movable = 2;
  vi.mocked(api).mockReset().mockImplementation((async (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, method: init?.method, body: init?.body });
    if (path.startsWith("/api/rss/source-space/preview")) return { movable };
    if (path === "/api/rss/source-space") return { space_id: JSON.parse(init!.body!).space_id, moved: movable };
    return {};
  }) as never);
});
afterEach(() => resetAppState());

const select = () => screen.getByRole("combobox", { name: "Keep subscriptions in" }) as HTMLSelectElement;

describe("RSS › Keep subscriptions in", () => {
  it("lists Only me and the shared spaces that can be written, with the explanation", () => {
    owner(true);
    render(<RssSourceSpaceWidget ctx={ctx} />);
    expect(within(select()).getAllByRole("option").map((o) => o.textContent)).toEqual(["Only me", "Team"]); // not the space the owner may only view
    expect(select().value).toBe("");
    expect(screen.getByText("Everyone in this space can see these subscriptions and their articles.")).toBeInTheDocument();
    expect(select()).toBeEnabled();
  });

  it("a member who may only view a space does not get it as a choice", () => {
    owner(false);
    render(<RssSourceSpaceWidget ctx={ctx} />);
    expect(within(select()).queryByRole("option", { name: "Reading club" })).toBeNull();
  });

  it("is read-only for anyone but the owner, showing the current value and why", () => {
    owner(false, { rss_source_space: "team" });
    render(<RssSourceSpaceWidget ctx={ctx} />);
    expect(select()).toBeDisabled();
    expect(select().value).toBe("team");
    expect(screen.getByText("Only the workspace owner can change this.")).toBeInTheDocument();
  });

  it("asks before moving subscriptions; confirming saves and shows the new value", async () => {
    owner(true);
    render(<RssSourceSpaceWidget ctx={ctx} />);
    await userEvent.selectOptions(select(), "team");
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Move 2 of your subscriptions to “Team”\?.*already saved stay where they are.*will not move it back/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(select().value).toBe("team"));
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ path: "/api/rss/source-space", body: JSON.stringify({ space_id: "team" }) });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved. 2 subscriptions moved.");
  });

  it("cancelling the question changes nothing", async () => {
    owner(true);
    render(<RssSourceSpaceWidget ctx={ctx} />);
    await userEvent.selectOptions(select(), "team");
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(select().value).toBe("");
  });

  it("with nothing to move it saves without asking", async () => {
    movable = 0;
    owner(true);
    render(<RssSourceSpaceWidget ctx={ctx} />);
    await userEvent.selectOptions(select(), "team");
    await waitFor(() => expect(select().value).toBe("team"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
  });

  it("switching back to Only me says nothing moves back, and cancelling changes nothing", async () => {
    owner(true, { rss_source_space: "team" });
    render(<RssSourceSpaceWidget ctx={ctx} />);
    await userEvent.selectOptions(select(), "");
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/stay there, and everyone in that space can still see them/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(select().value).toBe("team");
  });

  it("confirming the switch back saves the empty setting", async () => {
    owner(true, { rss_source_space: "team" });
    render(<RssSourceSpaceWidget ctx={ctx} />);
    await userEvent.selectOptions(select(), "");
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Switch back" }));
    await waitFor(() => expect(select().value).toBe(""));
    expect(calls.find((c) => c.method === "PUT")?.body).toBe(JSON.stringify({ space_id: "" }));
  });
});
