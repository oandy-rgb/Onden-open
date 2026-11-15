import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../lib/api";
import * as appStore from "../lib/appStore";
import BoardCardAudienceConfirm from "../components/BoardCardAudienceConfirm";
import type { ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { chooseNotesToPlace } from "../lib/boardCardAudience";
import { reads } from "../lib/data";
import { setLocalePref } from "../lib/i18n";
import * as moveLib from "../lib/moveToSpace";
import { refreshSpaces, resetSpacesForTest, spaceApi, type MovePreviewNumericEpoch, type Space } from "../lib/spaces";
import { ownerData } from "./ownerData";

// Putting an existing note on a board whose space has people who can't see it: one reminder (the
// sidebar's move confirmation) for all such notes, and nothing at all when everybody can see them.

const space = (id: string, name: string, over: Partial<Space> = {}): Space => ({
  id, name, kind: "shared", is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: false, ...over,
});
const ME = space("sp-me", "me", { kind: "personal", can_manage: true });
const TEAM = space("sp-team", "Team", { is_default: true });
const note = (id: string, title: string, space_id: string) => ({ id, title, parent_id: null, space_id, node_type: "content" }) as ContentNode;
const NODES = [note("board", "Board", "sp-team"), note("mine", "Mine", "sp-me"), note("mine2", "Mine too", "sp-me"), note("team1", "Team note", "sp-team")];
const look = (id: string, gain: MovePreviewNumericEpoch["gain"]): MovePreviewNumericEpoch => ({
  node_id: id, from: { id: "sp-me", name: "me", kind: "personal" }, to: { id: "sp-team", name: "Team", kind: "shared" },
  notes: 1, gain, lose: [], membership_epoch: 3,
});
const ANN = { id: "ann", name: "Ann", type: "human" as const };

beforeEach(async () => {
  setLocalePref("en");
  resetSpacesForTest();
  vi.spyOn(reads.people, "spaces").mockResolvedValue({ spaces: [ME, TEAM] } as never);
  await refreshSpaces();
  resetAppState({ data: { ...ownerData, nodes: NODES } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); resetSpacesForTest(); });

describe("chooseNotesToPlace", () => {
  it("places without asking when the note is in the board's space", async () => {
    const preview = vi.spyOn(spaceApi, "previewMove");
    await expect(chooseNotesToPlace("board", ["team1"])).resolves.toEqual(["team1"]);
    expect(preview).not.toHaveBeenCalled();
  });

  it("places without asking when nobody gains sight (the note is not narrower than the board)", async () => {
    vi.spyOn(spaceApi, "previewMove").mockResolvedValue(look("mine", [{ id: "sys", name: "System", type: "agent" }]));
    await expect(chooseNotesToPlace("board", ["mine"])).resolves.toEqual(["mine"]);
    expect(document.querySelector(".move-to-dialog")).toBeNull();
  });

  it("places when the look fails: the server stays the judge", async () => {
    vi.spyOn(spaceApi, "previewMove").mockRejectedValue(new Error("offline"));
    await expect(chooseNotesToPlace("board", ["mine"])).resolves.toEqual(["mine"]);
  });

  describe("when the board has people who can't see the note", () => {
    beforeEach(() => { vi.spyOn(spaceApi, "previewMove").mockImplementation(async (id) => look(id, [ANN])); });
    const ask = (ids: string[]) => { render(<BoardCardAudienceConfirm />); return chooseNotesToPlace("board", ids); };

    it("「Place anyway」 places and moves nothing", async () => {
      const move = vi.spyOn(moveLib, "moveToSpace");
      const result = ask(["mine"]);
      await userEvent.click(await screen.findByRole("button", { name: "Place anyway" }));
      await expect(result).resolves.toEqual(["mine"]);
      expect(move).not.toHaveBeenCalled();
    });

    it("「Cancel」 places nothing", async () => {
      const result = ask(["mine"]);
      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      await expect(result).resolves.toEqual([]);
    });

    it("「Move to this space」 moves the note, then places it", async () => {
      const move = vi.spyOn(moveLib, "moveToSpace").mockResolvedValue({ moved: 1 });
      const result = ask(["mine"]);
      expect(await screen.findByText("This card is in “Only me”; the other people on the board can't see it")).toBeInTheDocument();
      expect(screen.getByText("Will be able to see it: Ann")).toBeInTheDocument();
      await userEvent.click(await screen.findByRole("button", { name: "Move to this space" }));
      await expect(result).resolves.toEqual(["mine"]);
      expect(move).toHaveBeenCalledWith("mine", "sp-team", expect.objectContaining({ node_id: "mine" }));
    });

    it("asks once for several notes, moving only the ones that need it, and places all", async () => {
      const move = vi.spyOn(moveLib, "moveToSpace").mockResolvedValue({ moved: 2 });
      const result = ask(["mine", "team1", "mine2"]);
      expect(await screen.findByText("2 of these cards can't be seen by the board's other people")).toBeInTheDocument();
      expect(screen.getAllByText(/in Only me/)).toHaveLength(2);
      await userEvent.click(screen.getByRole("button", { name: "Move to this space" }));
      await expect(result).resolves.toEqual(["mine", "team1", "mine2"]);
      expect(move).toHaveBeenCalledWith(["mine", "mine2"], "sp-team", undefined);
    });

    it("a failed move keeps the reminder open and places nothing yet", async () => {
      vi.spyOn(moveLib, "moveToSpace").mockResolvedValue({ moved: 0 });
      let settled = false;
      const result = ask(["mine"]).then((r) => { settled = true; return r; });
      await userEvent.click(await screen.findByRole("button", { name: "Move to this space" }));
      await act(async () => { await Promise.resolve(); });
      expect(settled).toBe(false);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await expect(result).resolves.toEqual([]);
      await waitFor(() => expect(document.querySelector(".move-to-dialog")).toBeNull());
    });
  });

  describe("edge cases", () => {
    beforeEach(() => { vi.spyOn(spaceApi, "previewMove").mockImplementation(async (id) => look(id, [ANN])); });

    it("two placements in a row ask one after the other, and both settle", async () => {
      render(<BoardCardAudienceConfirm />);
      const first = chooseNotesToPlace("board", ["mine"]);
      const second = chooseNotesToPlace("board", ["mine2"]);
      await userEvent.click(await screen.findByRole("button", { name: "Place anyway" }));
      await expect(first).resolves.toEqual(["mine"]);
      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      await expect(second).resolves.toEqual([]);
    });

    it("when only some of several notes got moved, only those are placed", async () => {
      vi.spyOn(moveLib, "moveToSpace").mockResolvedValue({ moved: 1 });
      render(<BoardCardAudienceConfirm />);
      const result = chooseNotesToPlace("board", ["mine", "team1", "mine2"]);
      await userEvent.click(await screen.findByRole("button", { name: "Move to this space" }));
      await expect(result).resolves.toEqual(["mine", "team1"]);
    });

    it("a refused look (may not move it there) still places, and says some people may not see the card", async () => {
      vi.spyOn(spaceApi, "previewMove").mockRejectedValue(new ApiError(403, "{}"));
      const toast = vi.spyOn(appStore, "addToast");
      await expect(chooseNotesToPlace("board", ["mine"])).resolves.toEqual(["mine"]);
      expect(toast).toHaveBeenCalledWith("Placed. Some people on the board may not be able to see this card.", "info");
    });
  });
});
