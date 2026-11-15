import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { refreshSpaces, resetSpacesForTest, type Space } from "../lib/spaces";
import { resetAppState, setData, getAppState } from "../lib/appStore";
import { capabilitiesFor, useCapabilities } from "../lib/capabilities";

// What the current person may do, with the server's rules (unification audit
// W16): a note — the 編輯 permission in its space; a tag definition — the
// owner only; a space check — the permission, or `can_manage` (which the
// server grants the owner in a SHARED space and a person in their own).

beforeEach(() => { resetSpacesForTest(); resetAppState(); });
afterEach(() => vi.unstubAllGlobals());

const asOwner = (owner: boolean) => setData({ ...getAppState().data, actor_role: "viewer", actor_is_owner: owner });
const serve = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
const note = (space_id: string) => ({ space_id, node_type: "content" as const });
const tag = { space_id: null, node_type: "class_tag" as const };
type Standing = "viewer" | "editor" | "manager" | "owner-outside";
const space = (id: string, kind: Space["kind"], standing: Standing, capabilities: Space["capabilities"] = {} as Space["capabilities"]): Space => ({
  id, name: id, kind, is_default: false, owner_actor_id: null, capabilities,
  permission: standing === "viewer" ? "view" : standing === "owner-outside" ? null : "edit",
  can_manage: standing === "manager" || standing === "owner-outside",
});

describe("canEdit", () => {
  it("until the spaces load, a note stays editable (the server decides)", () => {
    asOwner(false);
    const { result } = renderHook(() => useCapabilities(false));
    expect(result.current.canEdit(note("s1"))).toBe(true);
  });

  it("the permission in the note's space decides, not the workspace role", async () => {
    serve({ is_owner: false, spaces: [
      { id: "lab", name: "Lab", kind: "shared", is_default: false, owner_actor_id: null, capabilities: {}, permission: "view", can_manage: false },
      { id: "mine", name: "personal", kind: "personal", is_default: false, owner_actor_id: "me", capabilities: {}, permission: "edit", can_manage: true },
    ] });
    asOwner(false);
    await refreshSpaces();
    const { result } = renderHook(() => useCapabilities(true));
    await waitFor(() => expect(result.current.canEdit(note("lab"))).toBe(false));
    expect(result.current.canEdit(note("mine"))).toBe(true);
  });

  it("a tag definition is the owner's alone — an editor elsewhere can't edit it", () => {
    const editorSomewhere = [space("lab", "shared", "editor")];
    expect(capabilitiesFor(false, editorSomewhere, true).canEdit(tag)).toBe(false);
    expect(capabilitiesFor(true, [], true).canEdit(tag)).toBe(true);
    expect(capabilitiesFor(false, [], false).canEdit(tag)).toBe(false); // known from bootstrap, not from spaces
  });

  it("editing a note needs the 編輯 permission there — the owner who can only 看 edits nothing", () => {
    // Note writes (write_node → spaceCanWrite) have no owner fallback.
    const caps = capabilitiesFor(true, [space("team", "shared", "viewer"), space("theirs", "personal", "viewer"), space("outside", "shared", "owner-outside")], true);
    expect(caps.canEdit(note("team"))).toBe(false);
    expect(caps.canEdit(note("outside"))).toBe(false);
    expect(caps.canEdit(note("theirs"))).toBe(false);
  });
});

describe("moving and managing", () => {
  it("move out: who manages the space, or an editor where the shared space allows it; move into: an editor", () => {
    const caps = capabilitiesFor(false, [], true);
    expect(caps.canMoveOut(space("a", "shared", "editor"))).toBe(false);
    expect(caps.canMoveOut(space("b", "shared", "editor", { members_can_move_out: true } as Space["capabilities"]))).toBe(true);
    expect(caps.canMoveOut(space("c", "personal", "manager"))).toBe(true);
    expect(caps.canMoveInto(space("d", "shared", "viewer"))).toBe(false);
    expect(caps.canMoveInto(space("e", "shared", "editor"))).toBe(true);
  });

  it("an owner who is only a viewer passes the space check for moving out, but the move writes the note, so it isn't offered", () => {
    const team = { ...space("team", "shared", "viewer"), can_manage: true }; // the server says so for the owner
    const caps = capabilitiesFor(true, [team], true);
    expect(caps.canMoveOut(team)).toBe(true);          // sourceAuthority: manage
    expect(caps.canEdit(note("team"))).toBe(false);    // write_node: real permission only → SpaceChip hides "Move to…"
  });

  it("managing a space: what the server marks can_manage — the owner on a shared space, a person on their own", () => {
    expect(capabilitiesFor(false, [], true).canManageSpace(space("a", "shared", "editor"))).toBe(false);
    expect(capabilitiesFor(true, [], true).canManageSpace(space("a", "shared", "owner-outside"))).toBe(true);
    expect(capabilitiesFor(true, [], true).canManageSpace(space("p", "personal", "viewer"))).toBe(false);
  });
});
