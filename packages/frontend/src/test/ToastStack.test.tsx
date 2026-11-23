import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import ToastStack from "../components/ToastStack";
import { addToast, getAppState, resetAppState } from "../lib/appStore";

describe("ToastStack (a11y live region)", () => {
  beforeEach(() => { resetAppState({ toasts: [] }); });

  it("exposes the stack as a polite status live region", () => {
    addToast("Saved", "success");
    render(<ToastStack />);
    const stack = document.body.querySelector(".toast-stack")!;
    expect(stack.getAttribute("role")).toBe("status");
    expect(stack.getAttribute("aria-live")).toBe("polite");
  });

  it("marks error toasts as assertive alerts so SR users are interrupted", () => {
    addToast("Save failed", "error");
    render(<ToastStack />);
    const errorToast = document.body.querySelector(".toast--error")!;
    expect(errorToast.getAttribute("role")).toBe("alert");
  });

  it("leaves success/info toasts without an alert role (announced via the polite region)", () => {
    addToast("Heads up", "info");
    render(<ToastStack />);
    const infoToast = document.body.querySelector(".toast--info")!;
    expect(infoToast.getAttribute("role")).toBeNull();
  });

  it("repeats of one message do not stack, and a plain error dismisses itself", () => {
    for (let i = 0; i < 5; i++) addToast("Bad value", "error");
    expect(getAppState().toasts).toHaveLength(1);
    expect(getAppState().toasts[0].duration).toBeGreaterThan(0);
    addToast("Server rejected", "error", { label: "Retry", onClick: () => {} });
    expect(getAppState().toasts[1].duration).toBe(0); // an action keeps it until dismissed
  });
});

describe("a notice that was working", () => {
  it("is announced as an alert when it turns into a failure (a new node, not a changed attribute)", async () => {
    const { startWorking, resetAppState } = await import("../lib/appStore");
    resetAppState();
    const notice = startWorking("Working…");
    render(<ToastStack />);
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => notice.fail("It failed."));
    expect(await screen.findByRole("alert")).toHaveTextContent("It failed.");
  });

  it("says there is still no answer after a long wait, and the answer still replaces it", async () => {
    vi.useFakeTimers();
    try {
      const { startWorking, resetAppState, getAppState } = await import("../lib/appStore");
      resetAppState();
      const notice = startWorking("Working…");
      act(() => { vi.runOnlyPendingTimers(); }); // the one timer is the "still no answer" one
      expect(getAppState().toasts[0]!.message).toMatch(/Still waiting for the server/);
      act(() => notice.done("Done."));
      expect(getAppState().toasts[0]).toMatchObject({ message: "Done.", kind: "success" });
    } finally { vi.useRealTimers(); }
  });
});
