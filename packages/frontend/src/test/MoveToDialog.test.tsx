import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MoveToDialog from "../components/MoveToDialog";
import { ApiError, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { reads } from "../lib/data";
import { setLocalePref } from "../lib/i18n";
import { refreshSpaces, resetSpacesForTest, spaceApi, type MovePreviewNumericEpoch, type Space } from "../lib/spaces";
import { ownerData } from "./ownerData";

// 「移動到…」: one picker for a space and a place in it. A pick in the note's
// own space is the ordinary change of parent; a pick in another space is
// previewed first and only 「移動」 moves it (docs/architecture/spaces.md).

const space = (id: string, name: string, over: Partial<Space> = {}): Space => ({
  id, name, kind: "shared", is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: false, ...over,
});
const PERSONAL = space("sp-me", "me", { kind: "personal", can_manage: true });
const SHARED = space("sp-shared", "Shared", { is_default: true });
const READ_ONLY = space("sp-read", "Read only", { permission: "view" });

const note = (id: string, title: string, space_id: string, parent_id: string | null = null, over: Partial<ContentNode> = {}) =>
  ({ id, title, parent_id, space_id, node_type: "content", ...over }) as ContentNode;
const NODES = [
  note("n", "Mine", "sp-me", "p"), note("p", "Parent", "sp-me"), note("kid", "Kid of mine", "sp-me", "n"), note("q", "Other", "sp-me"),
  note("r", "Team note", "sp-shared"), note("s", "Team folder", "sp-shared"), note("ro", "Read only note", "sp-read"),
  { id: "tag", title: "Tag row", node_type: "class_tag" } as ContentNode,
];

const preview = (over: Partial<MovePreviewNumericEpoch> = {}): MovePreviewNumericEpoch => ({
  node_id: "n", from: { id: "sp-me", name: "me", kind: "personal" }, to: { id: "sp-shared", name: "Shared", kind: "shared" },
  notes: 2, gain: [{ id: "ann", name: "Ann", type: "human" }], lose: [], membership_epoch: 7, ...over,
});

async function setup(spaces: Space[], { online = true, node = NODES[0]! }: { online?: boolean; node?: ContentNode } = {}) {
  resetSpacesForTest();
  vi.spyOn(reads.people, "spaces").mockResolvedValue({ spaces } as never);
  await refreshSpaces();
  resetAppState({ data: { ...ownerData, nodes: NODES }, online });
  const onPick = vi.fn(); const onClose = vi.fn();
  render(<MoveToDialog node={node} nodes={NODES} onPick={onPick} onClose={onClose} />);
  return { onPick, onClose, dialog: screen.getByRole("dialog") };
}
const labels = (dialog: HTMLElement) => within(dialog).getAllByRole("option").map((o) => o.querySelector(".place-picker-label")!.textContent);
const headings = (dialog: HTMLElement) => [...dialog.querySelectorAll(".place-picker-heading")].map((h) => h.textContent?.trim());

beforeEach(() => { setLocalePref("en"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); resetSpacesForTest(); });

describe("where focus starts", () => {
  const touchScreen = (coarse: boolean) => vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: coarse && query.includes("pointer: coarse"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);

  it("on a touch screen the search box is not focused (the keyboard would cover the list)", async () => {
    touchScreen(true);
    const { dialog } = await setup([PERSONAL, SHARED]);
    const box = dialog.querySelector("input[type='search']")!;
    expect(box).not.toBeNull();
    expect(box).not.toHaveFocus();
    expect(dialog).toHaveFocus();
  });

  it("with a mouse it is", async () => {
    touchScreen(false);
    const { dialog } = await setup([PERSONAL, SHARED]);
    expect(dialog.querySelector("input[type='search']")).toHaveFocus();
  });
});

describe("the picker's list", () => {
  it("groups by space, 最上層 first in each, and leaves out what cannot hold the note", async () => {
    const { dialog } = await setup([PERSONAL, SHARED, READ_ONLY]);
    expect(headings(dialog)).toEqual(["Only me", "Everyone"]);
    // Not the note itself, its sub-note, a tag, a note nobody may edit, or a space one may only read.
    expect(labels(dialog)).toEqual(["Top level", "Parent", "Other", "Top level", "Team note", "Team folder"]);
    expect(dialog.querySelector(".place-picker-where")).toHaveTextContent("Now in: Only me › Parent");
  });

  it("marks the current place and does not let it be picked", async () => {
    const { dialog, onPick, onClose } = await setup([PERSONAL, SHARED]);
    const here = within(dialog).getByRole("option", { name: /^Parent/ });
    expect(here).toHaveAttribute("aria-current", "location");
    expect(here).toHaveAttribute("aria-disabled", "true");
    expect(here).toHaveTextContent("Current place");
    await userEvent.click(here);
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers only the note's own space when it may not leave it", async () => {
    const team = note("t", "Team doc", "sp-shared", null);
    const { dialog } = await setup([PERSONAL, SHARED], { node: team });
    // Shared lets only its managers move notes out (members_can_move_out is off).
    expect(headings(dialog)).toEqual([]);
    expect(labels(dialog)).toEqual(["Top level", "Team note", "Team folder"]);
  });

  it("offers only the note's own space offline: a move between spaces needs the server", async () => {
    const { dialog } = await setup([PERSONAL, SHARED], { online: false });
    expect(headings(dialog)).toEqual([]);
    expect(labels(dialog)).toEqual(["Top level", "Parent", "Other"]);
  });
});

describe("a pick in the note's own space", () => {
  it("changes the parent at once, with no preview", async () => {
    const preview = vi.spyOn(spaceApi, "previewMove");
    const { dialog, onPick, onClose } = await setup([PERSONAL, SHARED]);
    await userEvent.click(within(dialog).getByRole("option", { name: "Other" }));
    expect(onPick).toHaveBeenCalledExactlyOnceWith("q");
    expect(onClose).toHaveBeenCalledOnce();
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("a pick in another space", () => {
  it("previews first, moves only on 「移動」, then sets the parent to the picked note", async () => {
    const previewMove = vi.spyOn(spaceApi, "previewMove").mockResolvedValue(preview());
    const move = vi.spyOn(spaceApi, "move").mockResolvedValue({ moved: 2 });
    const { dialog, onPick, onClose } = await setup([PERSONAL, SHARED]);
    await userEvent.click(within(dialog).getByRole("option", { name: "Team folder" }));
    expect(previewMove).toHaveBeenCalledExactlyOnceWith("n", "sp-shared");
    const confirm = await screen.findByRole("dialog", { name: "Move “Mine” to…" });
    expect(await within(confirm).findByText("Will be able to see it: Ann")).toBeInTheDocument();
    expect(within(confirm).getByText("Moving to: Everyone › Team folder")).toBeInTheDocument();
    expect(within(confirm).getByText("This note and 1 notes under it move.")).toBeInTheDocument();
    expect(within(confirm).getByText(/version history moves with it/i)).toBeInTheDocument();
    expect(move).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    await userEvent.click(within(confirm).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(move).toHaveBeenCalledExactlyOnceWith("n", "sp-shared", 7);
    expect(onPick).toHaveBeenCalledExactlyOnceWith("s");
    expect(move.mock.invocationCallOrder[0]!).toBeLessThan(onPick.mock.invocationCallOrder[0]!);
  });

  it("moving to another space's top level sets no parent", async () => {
    vi.spyOn(spaceApi, "previewMove").mockResolvedValue(preview());
    const move = vi.spyOn(spaceApi, "move").mockResolvedValue({ moved: 1 });
    const { dialog, onPick, onClose } = await setup([PERSONAL, SHARED]);
    await userEvent.click(within(dialog).getAllByRole("option", { name: "Top level" })[1]!);
    await userEvent.click(await screen.findByRole("button", { name: "Move" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(move).toHaveBeenCalledOnce();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("looks again after a 409 and moves nothing until asked", async () => {
    const previewMove = vi.spyOn(spaceApi, "previewMove")
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce(preview({ membership_epoch: 8, lose: [{ id: "bob", name: "Bob", type: "human" }] }));
    const move = vi.spyOn(spaceApi, "move").mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: "membership_changed" })))
      .mockResolvedValueOnce({ moved: 2 });
    const { dialog, onPick, onClose } = await setup([PERSONAL, SHARED]);
    await userEvent.click(within(dialog).getByRole("option", { name: "Team note" }));
    await userEvent.click(await screen.findByRole("button", { name: "Move" }));
    expect(await screen.findByText("Will no longer see it: Bob")).toBeInTheDocument();
    expect(previewMove).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(move).toHaveBeenLastCalledWith("n", "sp-shared", 8);
    expect(onPick).toHaveBeenCalledExactlyOnceWith("r");
  });

  it("goes back to the picker with 返回, moving nothing", async () => {
    vi.spyOn(spaceApi, "previewMove").mockResolvedValue(preview());
    const move = vi.spyOn(spaceApi, "move");
    const { dialog } = await setup([PERSONAL, SHARED]);
    await userEvent.click(within(dialog).getByRole("option", { name: "Team note" }));
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(await screen.findByRole("combobox", { name: "Search places to move to…" })).toBeInTheDocument();
    expect(move).not.toHaveBeenCalled();
  });
});
