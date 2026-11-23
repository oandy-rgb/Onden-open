// What the environment can do (lib/hostCapabilities.ts): a page with a server has accounts, members and the membership
// check; the local edition (the browser version, which declares itself before mounting the app) has none of them, so
// neither the account menu nor Settings offers 登出 there. Owner report 2026-11-23: 登出 in the browser version locked
// the workspace for good.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("../lib/accountSession", () => ({ useAccountSession: () => ({ user: { id: "u1", name: "我", email: "me@this-browser.onden" } }) }));
vi.mock("../lib/capabilities", () => ({ useIsOwner: () => true }));

import { hostCan } from "../lib/hostCapabilities";
import { declareLocalOnlyHost } from "../lib/localOnlyStatus";
import { getAppState, resetAppState, setMembershipGated } from "../lib/appStore";
import AccountPanel from "../components/AccountPanel";
import { SignOutSetting } from "../settings/AccountSetting";

afterEach(() => { cleanup(); declareLocalOnlyHost(false); resetAppState(); });

describe("what this environment can do", () => {
  it("a page with a server has accounts, members and the membership check", () => {
    expect([hostCan("accounts"), hostCan("members"), hostCan("membershipCheck")]).toEqual([true, true, true]);
  });

  it("the local edition has none of them once its shell declared it", () => {
    declareLocalOnlyHost();
    expect([hostCan("accounts"), hostCan("members"), hostCan("membershipCheck")]).toEqual([false, false, false]);
  });

  it("the membership gate is raised on a server and never in the local edition", () => {
    setMembershipGated(true);
    expect(getAppState().membershipGated).toBe(true);
    setMembershipGated(false);
    declareLocalOnlyHost();
    setMembershipGated(true);
    expect(getAppState().membershipGated).toBe(false);
  });
});

describe("signing out", () => {
  it("the account menu offers it on a server, and not in the local edition", () => {
    const { unmount } = render(<AccountPanel onBusyChange={() => {}} onOpenMembers={() => {}} />);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    unmount();
    declareLocalOnlyHost();
    render(<AccountPanel onBusyChange={() => {}} onOpenMembers={() => {}} />);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    // The person's own spaces are still managed from here (members inside that screen are the next step).
    expect(screen.getByRole("button", { name: "Spaces and members" })).toBeTruthy();
  });

  it("Settings › Account offers it on a server, and not in the local edition", () => {
    const { unmount } = render(<SignOutSetting />);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    unmount();
    declareLocalOnlyHost();
    render(<SignOutSetting />);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
