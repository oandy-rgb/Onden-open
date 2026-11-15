import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// A link inside an article to another article of the same feed is read in the reader (owner decision 2026-11-09):
// one the reader holds opens like 下一篇; any other page under the feed's own address is fetched and shown over the
// article, with 「‹ 回到…」 back to it; every other link, and a page that can't be read, goes to the browser.

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api")>();
  return { ...mod, api: apiMock };
});
vi.mock("../../lib/data", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/data")>();
  return { ...mod, sendWrite: vi.fn(async () => ({})) };
});

import { forgetRssPrefs } from "./rssPrefs";
import RssReaderPanel from "./RssReaderPanel";
import { bindAccountStorage } from "../../lib/accountStorage";
import { resetAppState } from "../../lib/appStore";
import { noWorkspaceData } from "../../lib/api";

bindAccountStorage("unit-test-account", "");

const WRITER = "https://medium.com/@ann";
const row = (id: string, title: string) => ({
  id, title, source_id: "s1", url: `${WRITER}/${id}`, published_at: "2026-11-01T00:00:00Z",
  fetched_at: "2026-11-01T00:00:00Z", seen: false, saved_node_id: null, excerpt: "", image: null,
});
const ROWS = [row("i1", "First story"), row("i2", "Second story")];
const feed = {
  id: "s1", title: "Ann", url: `${WRITER}/feed`, fetch_interval_minutes: 60, last_fetched_at: null, last_error: null,
  auto_tag: null, embed: false, unseen: 2, created_at: "2026-10-01T00:00:00Z", article_prefix: `${WRITER}/`,
};
const BODY = `<p>${"Body text. ".repeat(40)}</p>
<p><a href="${WRITER}/i2">held</a> <a href="${WRITER}/older">older</a> <a href="${WRITER}/broken">broken</a>
<a href="${WRITER}/i1">itself</a> <a href="https://medium.com/@bob/x">bob</a> <a href="https://elsewhere.test/a">elsewhere</a></p>`;

beforeEach(() => {
  localStorage.clear();
  forgetRssPrefs();
  resetAppState({ data: { ...noWorkspaceData }, online: true });
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/rss/sources")) return { sources: [feed], total_unseen: 2, latest_unseen_at: null, module_default: null };
    const link = /^\/api\/rss\/items\/i1\/link\?url=(.*)$/.exec(path);
    if (link) {
      const to = decodeURIComponent(link[1]!);
      return to.endsWith("/older") ? { kind: "page", url: to, title: "An older one", body: "<p>Written last year.</p>" } : { kind: "failed" };
    }
    const one = /^\/api\/rss\/items\/(i\d)$/.exec(path);
    if (one) return { ...ROWS.find((r) => r.id === one[1])!, body: BODY };
    if (path.startsWith("/api/rss/items")) return { items: ROWS, next_cursor: null };
    return {};
  });
});

async function openFirst() {
  render(<RssReaderPanel online onOpenNode={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: /First story/ }));
  await screen.findByRole("heading", { name: /First story/ });
}
const linkCalls = () => apiMock.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/link?"));

describe("links inside an article", () => {
  it("a page of the same feed is read over the article, and 「‹ 回到…」 brings the article back", async () => {
    await openFirst();
    fireEvent.click(screen.getByText("older"));
    expect(await screen.findByRole("heading", { name: "An older one" })).toBeInTheDocument();
    expect(screen.getByText("Written last year.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to the article" }));
    expect(await screen.findByRole("heading", { name: /First story/ })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "An older one" })).toBeNull();
  });

  it("an article the reader holds opens like 下一篇, without asking the server", async () => {
    await openFirst();
    fireEvent.click(screen.getByText("held"));
    expect(await screen.findByRole("heading", { name: /Second story/ })).toBeInTheDocument();
    expect(linkCalls()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Back to the article" }));
    expect(await screen.findByRole("heading", { name: /First story/ })).toBeInTheDocument();
  });

  it("another writer, another site, a modified click: left to the browser; a page that can't be read offers it", async () => {
    await openFirst();
    // Whether the reader took the click, seen last; then the test stops the browser's own navigation.
    const taken: boolean[] = [];
    const stop = (e: Event) => { taken.push(e.defaultPrevented); e.preventDefault(); };
    window.addEventListener("click", stop);
    try {
      for (const text of ["bob", "elsewhere"]) fireEvent.click(screen.getByText(text));
      fireEvent.click(screen.getByText("older"), { ctrlKey: true });
    } finally { window.removeEventListener("click", stop); }
    expect(taken).toEqual([false, false, false]);
    expect(linkCalls()).toEqual([]);

    fireEvent.click(screen.getByText("broken"));
    expect(await screen.findByText(/This page can't be read here/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: /Open in the browser/ })).toHaveAttribute("href", `${WRITER}/broken`));
  });

  it("「原文」 above the article and a link to the article itself go to the browser, though both are under the feed's address", async () => {
    await openFirst();
    const taken: boolean[] = [];
    const stop = (e: Event) => { taken.push(e.defaultPrevented); e.preventDefault(); };
    window.addEventListener("click", stop);
    try {
      fireEvent.click(screen.getByRole("link", { name: /original/ }));
      fireEvent.click(screen.getByText("itself"));
    } finally { window.removeEventListener("click", stop); }
    expect(taken).toEqual([false, false]);
    expect(linkCalls()).toEqual([]);
    expect(screen.getByRole("link", { name: /original/ })).toHaveAttribute("href", `${WRITER}/i1`);
    expect(screen.getByRole("link", { name: /original/ })).toHaveAttribute("target", "_blank");
  });
});
