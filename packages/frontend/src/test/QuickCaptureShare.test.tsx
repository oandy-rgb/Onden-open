// 「分享 → Onden」: a share opens quick capture prefilled (lib/share). The text
// lands in the box after any unsaved draft, the fetched page title replaces
// the bare link, and shared images upload on Save as image embeds — online
// only: offline the sheet says images need a connection.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const uploadMedia = vi.fn();
vi.mock("../lib/data/media", () => ({ uploadMedia: (file: File) => uploadMedia(file) }));

import QuickCapture from "../modules/capture/QuickCapture";
import { captureProps } from "./helpers/captureProps";
import { bindAccountStorage } from "../lib/accountStorage";
import { resetAppState } from "../lib/appStore";
import { PREFS, removePref, setPref } from "../lib/prefs";
import type { IncomingShare } from "../lib/share/shareInbox";
import { parseSharePayload, type RawShare } from "../lib/share/sharePayload";

let nextId = 100;
const incoming = (raw: RawShare, extra: Partial<IncomingShare> = {}): IncomingShare =>
  ({ ...parseSharePayload(raw), id: nextId++, ...extra });
const png = (name: string) => new File([new Uint8Array([1])], name, { type: "image/png" });

function renderCapture(share: IncomingShare | null, online = true) {
  const props = captureProps({ online });
  const view = render(<QuickCapture {...props} share={share} />);
  const rerender = (next: IncomingShare | null) => view.rerender(<QuickCapture {...props} share={next} />);
  return { rerender };
}
const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const posts = () => sendOrQueue.mock.calls.filter(([method, path]) => method === "POST" && path === "/api/nodes")
  .map(([, , body]) => JSON.parse(body as string) as { title: string; markdown: string; parent_id: string | null });

beforeAll(() => { bindAccountStorage("user-1", "https://onden.example/"); });
beforeEach(() => {
  resetAppState();
  removePref(PREFS.quickCaptureDraft);
  sendOrQueue.mockReset().mockResolvedValue(undefined);
  uploadMedia.mockReset().mockImplementation(async (file: File) => `/api/media/${file.name}`);
});

describe("QuickCapture prefilled by a share", () => {
  it("opens with a shared link and swaps in the fetched page title", async () => {
    const share = incoming({ url: "https://example.com/p" });
    const { rerender } = renderCapture(share);
    expect(await screen.findByRole("textbox")).toHaveValue("https://example.com/p");
    rerender({ ...share, titledDraft: "Page title\nhttps://example.com/p" });
    await waitFor(() => expect(textarea()).toHaveValue("Page title\nhttps://example.com/p"));
  });

  it("a share that already has its title is inserted once, with the title", async () => {
    renderCapture(incoming({ url: "https://example.com/p" }, { titledDraft: "Page title\nhttps://example.com/p" }));
    expect(await screen.findByRole("textbox")).toHaveValue("Page title\nhttps://example.com/p");
  });

  it("does not overwrite the link once the user has edited it", async () => {
    const share = incoming({ url: "https://example.com/p" });
    const { rerender } = renderCapture(share);
    await userEvent.clear(await screen.findByRole("textbox"));
    await userEvent.type(textarea(), "my own words");
    rerender({ ...share, titledDraft: "Page title\nhttps://example.com/p" });
    expect(textarea()).toHaveValue("my own words");
  });

  it("adds shared text after an unsaved draft instead of replacing it", async () => {
    setPref(PREFS.quickCaptureDraft, "half a thought");
    renderCapture(incoming({ text: "shared words" }));
    expect(await screen.findByRole("textbox")).toHaveValue("half a thought\n\nshared words");
  });

  it("a second share while open is added, not swapped in", async () => {
    const { rerender } = renderCapture(incoming({ text: "first" }));
    await screen.findByRole("textbox");
    rerender(incoming({ text: "second" }));
    await waitFor(() => expect(textarea()).toHaveValue("first\n\nsecond"));
  });

  it("uploads shared images on Save and puts them under the text as image embeds", async () => {
    renderCapture(incoming({ text: "Whiteboard", files: [png("a.png"), png("b.png")] }));
    expect(await screen.findByRole("list", { name: "Attached images" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    expect(posts()).toEqual([expect.objectContaining({
      title: "Whiteboard",
      markdown: "Whiteboard\n\n![a](/api/media/a.png)\n![b](/api/media/b.png)",
      parent_id: null,
    })]);
  });

  it("saves images alone, and a removed image is not uploaded", async () => {
    renderCapture(incoming({ files: [png("keep.png"), png("drop.png")] }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove image drop.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(uploadMedia.mock.calls.map(([f]) => (f as File).name)).toEqual(["keep.png"]);
    expect(posts()[0]!.markdown).toBe("![keep](/api/media/keep.png)");
  });

  it("a failed upload keeps everything for a retry, which does not upload twice", async () => {
    uploadMedia.mockReset()
      .mockImplementationOnce(async () => "/api/media/one.png")
      .mockRejectedValueOnce(new Error("network"))
      .mockImplementation(async () => "/api/media/two.png");
    renderCapture(incoming({ text: "two pics", files: [png("one.png"), png("two.png")] }));
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
    expect(posts()).toHaveLength(0);
    expect(textarea()).toHaveValue("two pics");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(uploadMedia).toHaveBeenCalledTimes(3);
    expect(posts()[0]!.markdown).toBe("two pics\n\n![one](/api/media/one.png)\n![two](/api/media/two.png)");
  });

  it("offline: says images need a connection and does not save them", async () => {
    renderCapture(incoming({ text: "later", files: [png("a.png")] }), false);
    expect(await screen.findByText("Images need a connection to upload. Connect, then save — or remove the images.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    // Removing the image lets the text go through the offline queue as usual.
    await userEvent.click(screen.getByRole("button", { name: "Remove image a.png" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("names shared files it cannot attach", async () => {
    renderCapture(incoming({ files: [new File([new Uint8Array([1])], "IMG.HEIC", { type: "image/heic" })] }));
    expect(await screen.findByText("Not attached (not an image Onden can store): IMG.HEIC")).toBeInTheDocument();
  });
});
