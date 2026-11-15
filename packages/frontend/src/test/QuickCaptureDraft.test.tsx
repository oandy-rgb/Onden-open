// @vitest-environment jsdom
// Closing the capture sheet hides it; the typed text stays until it is saved
// or deleted, including across a reload (UX walkthrough F5).
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const sendOrQueue = vi.fn();
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async (r: { method: string; path: string; body: string | null }) => {
    const value = await sendOrQueue(r.method, r.path, r.body);
    return value === undefined ? { status: "queued" } : { status: "synced", value };
  },
}));
vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(),
  upsertNode: async () => {},
  removeNode: async () => {},
}));

import QuickCapture from "../modules/capture/QuickCapture";
import { captureProps } from "./helpers/captureProps";
import { resetAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";

const renderCapture = (initialDraft?: string) =>
  render(<QuickCapture {...captureProps()} initialDraft={initialDraft} />);

beforeAll(() => { bindAccountStorage("user-1", "https://onden.example/"); });
beforeEach(() => {
  localStorage.clear();
  resetAppState();
  sendOrQueue.mockReset().mockResolvedValue(undefined);
});

describe("QuickCapture draft", () => {
  it("Esc closes the sheet and a remount brings the text back", async () => {
    const first = renderCapture("half a thought");
    await userEvent.type(screen.getByRole("textbox"), "{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    first.unmount();

    renderCapture("");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("half a thought");
  });

  it("a shared item goes after an unsaved draft instead of replacing it", async () => {
    const first = renderCapture("draft");
    first.unmount();
    renderCapture("shared link");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("draft\n\nshared link");
  });

  it("a successful save clears the stored draft", async () => {
    const first = renderCapture("Buy milk");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalled());
    await waitFor(() => expect(Object.keys(localStorage).some((k) => k.startsWith("onden.quickCaptureDraft"))).toBe(false));
    first.unmount();
  });
});
