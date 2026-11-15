import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

// The inbox lists an AI's suggestion while a place of it is undecided. Deciding a place in the note
// must make the inbox read again at once (the live tick for the person's own write is collapsed as an
// echo), so the card and the counts clear without a reload.
vi.mock("../lib/liveInvalidation", () => ({ useLiveRefetch: vi.fn() }));
vi.mock("../hooks/useDueSoonNotifications", () => ({ useDueSoonNotifications: () => ({}) }));
vi.mock("../hooks/useNotificationToasts", () => ({ useNotificationToasts: () => undefined }));
vi.mock("../hooks/useBodyConflictNotice", () => ({ useBodyConflictNotice: () => undefined }));
const { useWorkspaceLive } = await import("../hooks/useWorkspaceLive");
const { announceSuggestionsChanged } = await import("../lib/aiSuggestionsBus");

afterEach(cleanup);

describe("the inbox after places of a suggestion are decided", () => {
  it("is read again, and stops listening when the workspace closes", () => {
    const loadInboxReview = vi.fn(async () => undefined);
    const { unmount } = renderHook(() => useWorkspaceLive({ sync: async () => undefined, loadInboxReview, openNote: vi.fn() }));
    announceSuggestionsChanged("n1", true, true);
    expect(loadInboxReview).toHaveBeenCalledTimes(1);
    unmount();
    announceSuggestionsChanged("n1");
    expect(loadInboxReview).toHaveBeenCalledTimes(1);
  });
});
