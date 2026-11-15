// One notice at a time: 「這次更新」 waits for toasts and dialogs, is not in the top layer, and is a
// single line on a phone.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const unseen = [{ id: "2026-11-02-a", date: "2026-11-02", zh: "新東西", en: "New thing" }];
vi.mock("../hooks/useUnseenChanges", () => ({ useUnseenChanges: () => ({ unseen, markAllSeen: () => {} }) }));
let phone = false;
vi.mock("../hooks/useIsMobile", async (importOriginal) => ({ ...await importOriginal<typeof import("../hooks/useIsMobile")>(), useIsMobile: () => phone }));

import DeviceNotices from "../components/DeviceNotices";
import { Modal } from "../components/ui";
import { addToast, resetAppState } from "../lib/appStore";

afterEach(() => { cleanup(); resetAppState(); phone = false; });

describe("「這次更新」 in the device notices", () => {
  it("shows alone, outside any dialog", () => {
    render(<DeviceNotices />);
    expect(screen.getByLabelText("What's new").closest("dialog")).toBeNull();
  });
  it("steps aside for a toast and for an open dialog, and comes back", () => {
    const { rerender } = render(<DeviceNotices />);
    act(() => addToast("Saved", "success"));
    expect(screen.queryByLabelText("What's new")).toBeNull();
    act(() => { resetAppState(); });
    expect(screen.getByLabelText("What's new")).toBeTruthy();
    rerender(<><DeviceNotices /><Modal label="Account" onClose={() => {}}><p>x</p></Modal></>);
    expect(screen.queryByLabelText("What's new")).toBeNull();
    rerender(<DeviceNotices />);
    expect(screen.getByLabelText("What's new")).toBeTruthy();
  });
  it("is one line on a phone", () => {
    phone = true;
    render(<DeviceNotices />);
    expect(screen.getByText(/New features/)).toBeTruthy();
    expect(screen.queryByText("New thing")).toBeNull();
  });
});
