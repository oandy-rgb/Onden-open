// useIncomingShare (lib/share/shareInbox.ts): a share the page opened with is
// handed to quick capture once, with the page's title fetched by the server
// when online; offline, the link stays as shared.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const linkTitle = vi.fn();
vi.mock("../lib/data/reads", async (original) => {
  const actual = await original<typeof import("../lib/data/reads")>();
  return { ...actual, reads: { ...actual.reads, workspace: { ...actual.reads.workspace, linkTitle: (url: string) => linkTitle(url) } } };
});

import { resetShareInboxForTests, useIncomingShare } from "../lib/share/shareInbox";

beforeEach(() => {
  resetShareInboxForTests();
  linkTitle.mockReset().mockResolvedValue("Fetched title");
});

describe("useIncomingShare", () => {
  it("delivers the URL's share with the fetched page title", async () => {
    const { result } = renderHook(() => useIncomingShare({ url: "https://example.com/p" }, true));
    await waitFor(() => expect(result.current?.titledDraft).toBe("Fetched title\nhttps://example.com/p"));
    expect(result.current).toMatchObject({ url: "https://example.com/p", draft: "https://example.com/p", images: [] });
    expect(linkTitle).toHaveBeenCalledWith("https://example.com/p");
  });

  it("offline: no title fetch, the link as shared", async () => {
    const { result } = renderHook(() => useIncomingShare({ title: "Shared", url: "https://example.com/p" }, false));
    await waitFor(() => expect(result.current?.draft).toBe("Shared\nhttps://example.com/p"));
    expect(result.current?.titledDraft).toBeUndefined();
    expect(linkTitle).not.toHaveBeenCalled();
  });

  it("hands the page's share over once, even across a remount", async () => {
    const first = renderHook(() => useIncomingShare({ text: "once" }, true));
    await waitFor(() => expect(first.result.current?.draft).toBe("once"));
    first.unmount();
    const second = renderHook(() => useIncomingShare({ text: "once" }, true));
    await new Promise((r) => setTimeout(r, 20));
    expect(second.result.current).toBeNull();
  });

  it("nothing shared: nothing delivered", async () => {
    const { result } = renderHook(() => useIncomingShare(null, true));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
  });
});
