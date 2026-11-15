import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { excerptBlock } from "@onden/markdown";
import { replaceAllAnchors } from "../../lib/blockAnchorStore";
import { excerptEmbed } from "./rssQuote";

// 「這週讀到的」: only when the week has excerpts from feeds; closing hides it for the week;
// 「寫點想法」 starts one draft embedding them.

const { startWeekDraft } = vi.hoisted(() => ({ startWeekDraft: vi.fn() }));
vi.mock("./rssQuote", async (importOriginal) => ({ ...(await importOriginal<typeof import("./rssQuote")>()), startWeekDraft }));

import RssWeekCard from "./RssWeekCard";
import { bindAccountStorage } from "../../lib/accountStorage";
import { resetAppState } from "../../lib/appStore";
import { noWorkspaceData } from "../../lib/api";

bindAccountStorage("unit-test-account", "");

const today = "2026-11-04";
/** A note whose text is one excerpt, anchored at its start the way the server does (lib/blockAnchorStore). */
const noteWith = (title: string, id: string) => {
  const markdown = excerptBlock({ exact: "Worth keeping" }, { title: "Post", url: "https://x.test/p", feed: "Blog" });
  replaceAllAnchors([{ anchor_id: id, note_id: `n-${id}`, from: 0, to: markdown.length, status: "valid", candidate_from: null, candidate_to: null, quote: markdown.slice(0, 40) }], [`n-${id}`]);
  return { id: `n-${id}`, title, node_type: "content", updated_at: "2026-11-04T01:00:00Z", markdown };
};
const dest = { tagIds: [], parentId: null };

beforeEach(() => {
  localStorage.clear();
  startWeekDraft.mockReset();
  startWeekDraft.mockResolvedValue({ nodeId: "draft-1", status: "synced" });
});

describe("the week card", () => {
  it("is not there when the week has no excerpts", () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [] } as never, online: true });
    const { container } = render(<RssWeekCard today={today} destination={dest} onOpenDraft={() => {}} />);
    expect(container.querySelector(".rss-week")).toBeNull();
  });

  it("lists the week's excerpts and starts a draft embedding them", async () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [noteWith("2026-11-03", "aaa111")] } as never, online: true });
    const open = vi.fn();
    render(<RssWeekCard today={today} destination={dest} onOpenDraft={open} />);
    expect(screen.getByText(/Worth keeping/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Write about it" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("draft-1"));
    expect(startWeekDraft.mock.calls[0]![0].embeds).toEqual([excerptEmbed("2026-11-03", "Worth keeping")]);
  });

  it("closing it hides it for the rest of the week", async () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [noteWith("2026-11-03", "aaa111")] } as never, online: true });
    const first = render(<RssWeekCard today={today} destination={dest} onOpenDraft={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Hide until next week" }));
    expect(first.container.querySelector(".rss-week")).toBeNull();
    first.unmount();
    expect(render(<RssWeekCard today={today} destination={dest} onOpenDraft={() => {}} />).container.querySelector(".rss-week")).toBeNull();
    // Next week (a note from then) it is back.
    resetAppState({ data: { ...noWorkspaceData, nodes: [{ ...noteWith("Ideas", "bbb222"), updated_at: "2026-11-10T01:00:00Z" }] } as never, online: true });
    expect(render(<RssWeekCard today="2026-11-10" destination={dest} onOpenDraft={() => {}} />).container.querySelector(".rss-week")).not.toBeNull();
  });
});
