import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SpaceChip from "../components/SpaceChip";
import { resetSpacesForTest } from "../lib/spaces";
import { setLocalePref } from "../lib/i18n";
import { resetAppState } from "../lib/appStore";
import type { ContentNode } from "../lib/api";

// The note's space next to its title (docs/architecture/spaces.md): hidden
// on tags; opening it names who can see the note and a move
// first previews who gains and loses access, then sends the confirmed epoch.

const node = { id: "n1", title: "Draft", node_type: "content", source_type: "manual", slug: "draft", markdown: "",
  parent_id: null, hidden: false, sort_order: 0, space_id: "everyone" } as unknown as ContentNode;
const spaces = [
  { id: "everyone", name: "共用", kind: "shared", is_default: true, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: true },
  { id: "mine", name: "personal", kind: "personal", is_default: false, owner_actor_id: "me", capabilities: {}, permission: "edit", can_manage: true },
];

function stub(gain: unknown[] = []) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    const body = u.endsWith("/api/spaces") ? { spaces }
      : u.includes("/members") ? { members: [{ id: "me", name: "Me", type: "human", permission: "edit" }, { id: "prof", name: "Prof", type: "human", permission: "view" }] }
      : u.includes("/move-preview") ? { node_id: "n1", from: spaces[0], to: spaces[1], notes: 1, gain, lose: [{ id: "prof", name: "Prof" }], membership_epoch: "7" }
      : u.endsWith("/api/spaces/move") ? { moved: 1 } : {};
    return new Response(JSON.stringify(body));
  }));
  return calls;
}

beforeEach(() => { resetSpacesForTest(); resetAppState(); });
afterEach(() => vi.unstubAllGlobals());

describe("SpaceChip", () => {
  it("stays hidden on a tag, which belongs to no space", () => {
    stub();
    const tag = { ...node, node_type: "class_tag", space_id: null } as unknown as ContentNode;
    const { container } = render(<SpaceChip node={tag} online />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the audience, previews a move and sends the confirmed epoch", async () => {
    const calls = stub();
    const onMoved = vi.fn();
    render(<SpaceChip node={node} online onMoved={onMoved} />);
    fireEvent.click(await screen.findByRole("button", { name: /Everyone/ }));
    expect(await screen.findByText("Prof")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "mine" } });
    expect(await screen.findByText("Will no longer see it: Prof")).toBeInTheDocument();
    expect(screen.getByText(/version history moves with it/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    const move = calls.find((c) => c.url.endsWith("/api/spaces/move"))!;
    expect(JSON.parse(String(move.init!.body))).toEqual({ node_id: "n1", to_space_id: "mine", membership_epoch: "7" });
  });

  it("labels its space dropdown 「換到其他空間…」, apart from the note menu's 「移動到…」", async () => {
    stub();
    setLocalePref("zh-TW");
    try {
      render(<SpaceChip node={node} online />);
      fireEvent.click(await screen.findByRole("button", { name: /所有成員/ }));
      expect(await screen.findByText("換到其他空間…")).toBeInTheDocument();
      expect(screen.queryByText("移動到…")).toBeNull();
    } finally { setLocalePref("en"); }
  });

  const system = { id: "sys", name: "System", type: "agent" };
  const ann = { id: "ann", name: "Ann", type: "human" };

  async function openPreview() {
    render(<SpaceChip node={node} online />);
    fireEvent.click(await screen.findByRole("button", { name: /Everyone/ }));
    await screen.findByText("Prof");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "mine" } });
    await screen.findByText(/Will no longer see it/);
  }

  it("lists the people who gain access, not the built-in System account", async () => {
    stub([system, ann]);
    await openPreview();
    expect(screen.getByText("Will be able to see it: Ann")).toBeInTheDocument();
    expect(screen.queryByText(/System/)).toBeNull();
  });

  it("shows no 'will be able to see it' line when only System would gain", async () => {
    stub([system]);
    await openPreview();
    expect(screen.queryByText(/Will be able to see it/)).toBeNull();
  });
});
