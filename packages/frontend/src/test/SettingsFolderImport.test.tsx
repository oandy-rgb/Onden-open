import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsModal from "../settings/SettingsModal";
import { api, ApiError } from "../lib/api";

// SettingsModal mounts the account section, which subscribes to the better-auth session store; nanostores
// cleans that up on a 1s timer that can fire after jsdom is gone (window is not defined). This file is not about auth.
vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }), signOut: vi.fn(), getSession: vi.fn() } }));
vi.mock("../lib/api", async (load) => ({ ...await load<typeof import("../lib/api")>(), api: vi.fn() }));
const post = vi.fn();
const list = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  list.mockResolvedValue({sources:[]});
  vi.mocked(api).mockImplementation((url,options) => url === "/api/import/sources" ? list() : url === "/api/backup/history-size" ? Promise.resolve({ notes: 0, versions: 0, bytes: 0 }) : url === "/api/backup/size" ? Promise.resolve({ bytes: 0 }) : url === "/api/backup/restore/limit" ? Promise.resolve({ max_bytes: 16 * 1024 ** 3 }) : post(url,options));
  vi.spyOn(console,"error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function open(onImportDone = vi.fn()) {
  const user = userEvent.setup();
  const { baseElement: container } = render(<SettingsModal online onClose={vi.fn()} onConnect={vi.fn()} onImportDone={onImportDone} />);
  await user.click(screen.getByRole("button", { name: "Data and backup" }));
  const input = () => container.querySelector<HTMLInputElement>("input[webkitdirectory]")!;
  // The folder import widget loads when the tab is shown (modules/importers).
  await waitFor(() => expect(input()).not.toBeNull());
  return { user, input, onImportDone };
}
function file(path = "Vault/課程/筆記.md", text = async () => "note text") {
  const f = new File(["data"], path.split("/").at(-1)!);
  Object.defineProperties(f, { webkitRelativePath: { value: path.includes("/") ? path : "" }, text: { value: text } });
  return f;
}

describe("folder import feedback", () => {
  it("recovers from a local read error before upload, including selecting the same folder again", async () => {
    const { user, input } = await open();
    const f = file(undefined, async () => { throw new Error("Unreadable local file"); });
    for (let i = 0; i < 2; i++) {
      await user.upload(input(), f);
      expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was uploaded");
      expect(post).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Choose folder again" }));
    }
  });
  it("preserves Chinese nested paths, reports reuse/skips, and refreshes only after acknowledgement", async () => {
    const { user, input, onImportDone } = await open();
    post.mockResolvedValue({ imported: 1, skipped: 1, folders: 0, folders_reused: 2, folders_skipped: 1, collection_rows_skipped: 3, images_reused: 2, image_refs_unresolved: 1 });
    await user.upload(input(), [file(), file("Vault/課程/附件.enex")]);
    expect(post).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button",{name:"Start import"}));
    await waitFor(() => expect(onImportDone).toHaveBeenCalledTimes(1));
    expect(JSON.parse(post.mock.calls[0]![1].body)).toMatchObject({ files:[{path:"課程/筆記.md",content:"note text"}],upsert:true,source:{name:"Vault",id:expect.any(String)} });
    expect(screen.getByRole("status")).toHaveTextContent("2 folders reused");
    expect(screen.getByRole("status")).toHaveTextContent("2 images reused");
    expect(screen.getByRole("status")).toHaveTextContent("1 image references could not be matched");
    expect(screen.getByRole("status")).toHaveTextContent("their notes were not moved to the root");
    expect(screen.getByRole("status")).toHaveTextContent("3 collection rows skipped");
    expect(screen.getByRole("status")).toHaveTextContent("1 unsupported files skipped (.enex)");
  });
  it("lists every file it did not import with the reason, and counts hidden files", async () => {
    const { user, input } = await open();
    post.mockResolvedValue({ imported: 1, skipped: 1, folders: 0, images_skipped: 1,
      conflicts: [{ path: "重複（資料夾/b.md", reason: "folder_unavailable" }],
      skipped_images: [{ path: "圖片/bad.png", reason: "unreadable" }] });
    await user.upload(input(), [file(), file("Vault/課程/附件.enex"), file("Vault/.obsidian/app.md")]);
    await user.click(await screen.findByRole("button",{name:"Start import"}));
    await screen.findByText("Files not imported (3)");
    expect(JSON.parse(post.mock.calls[0]![1].body).files.map((f: { path: string }) => f.path)).toEqual(["課程/筆記.md"]);
    for (const [path, reason] of [["重複（資料夾/b.md","Its folder could not be created or reused; not imported"],["圖片/bad.png","Not a readable file of its type"],["課程/附件.enex","Unsupported file type"]]) {
      expect(screen.getByText(path).closest("li")).toHaveTextContent(reason!);
    }
    expect(screen.getByRole("status")).toHaveTextContent("1 hidden files left out");
  });
  it("lists a note over the size cap as not imported, and the titles it shortened (D67)", async () => {
    const { user, input } = await open();
    post.mockResolvedValue({ imported: 1, skipped: 1, folders: 0,
      conflicts: [{ path: "大.md", reason: "too_large" }],
      titles_truncated: [{ path: "長標題.md" }, { path: "db.csv", row: 3 }] });
    await user.upload(input(), [file()]);
    await user.click(await screen.findByRole("button",{name:"Start import"}));
    await screen.findByText("Files not imported (1)");
    expect(screen.getByText("大.md").closest("li")).toHaveTextContent("Over the 2,000,000-character note limit; not imported");
    expect(screen.getByText("Titles shortened to 500 characters (2)")).toBeInTheDocument();
    expect(screen.getByText("db.csv").closest("li")).toHaveTextContent("Row 3");
  });
  it("uploads a vault's PDFs with the images and says how many came in", async () => {
    const { user, input } = await open();
    // Two batches: the PDF (stored files go first), then the note.
    post.mockResolvedValueOnce({ imported: 0, skipped: 0, folders: 0, images_imported: 3, pdfs_imported: 1 })
      .mockResolvedValueOnce({ imported: 1, skipped: 0, folders: 0 });
    await user.upload(input(), [file(), file("Vault/考卷.pdf")]);
    await user.click(await screen.findByRole("button",{name:"Start import"}));
    await screen.findByText("1 PDFs imported");
    const files = post.mock.calls.flatMap(call => JSON.parse(call[1].body).files as Array<{ path: string; kind?: string }>);
    expect(files.find(f => f.path === "考卷.pdf")).toMatchObject({ kind: "pdf", base64: expect.any(String) });
    expect(screen.getByRole("status")).toHaveTextContent("2 images imported");
  });
  it("uploads audio and documents as media too, and lists relations that kept their text (D91)", async () => {
    const { user, input } = await open();
    post.mockResolvedValueOnce({ imported: 0, skipped: 0, folders: 0, images_imported: 2 })
      .mockResolvedValueOnce({ imported: 1, skipped: 0, folders: 0, relations_resolved: 1, relations_unresolved: 1,
        unresolved_relations: [{ path: "筆記.md", key: "owner", value: "[[Gone]]" }] });
    await user.upload(input(), [file(), file("Vault/attachments/song.mp3"), file("Vault/attachments/講義.docx")]);
    await user.click(await screen.findByRole("button",{name:"Start import"}));
    await screen.findByText("1 relations linked");
    const files = post.mock.calls.flatMap(call => JSON.parse(call[1].body).files as Array<{ path: string; kind?: string }>);
    expect(files.filter(f => f.path.startsWith("attachments/"))).toMatchObject([
      { path: "attachments/song.mp3", kind: "media", base64: expect.any(String) },
      { path: "attachments/講義.docx", kind: "media", base64: expect.any(String) },
    ]);
    expect(screen.getByText("1 relations could not be matched to a note; their [[link]] text was kept")).toBeInTheDocument();
    expect(screen.getByText("筆記.md · owner").closest("li")).toHaveTextContent("[[Gone]]");
  });
  const trashVault = () => [file(), file("Vault/.trash/舊筆記.md"), file("Vault/.trash/課程/草稿.md"), file("Vault/.trash/.obsidian/x.md"), file("Vault/.obsidian/app.md")];
  const sentPaths = () => post.mock.calls.flatMap(call => JSON.parse(call[1].body).files.map((f: { path: string }) => f.path));
  it("leaves Obsidian's trash out unless asked, and says how many notes were left out", async () => {
    post.mockResolvedValue({ imported: 1, skipped: 0, folders: 0 });
    const { user, input } = await open();
    await user.upload(input(), trashVault());
    expect(await screen.findByRole("checkbox", { name: "Also import Obsidian's trash (.trash, 2 notes)" })).not.toBeChecked();
    await user.click(screen.getByRole("button",{name:"Start import"}));
    await screen.findByText("2 notes in Obsidian's trash (.trash) not imported");
    expect(sentPaths()).toEqual(["課程/筆記.md"]);
  });
  it("imports Obsidian's trash under its own folder, keeping subfolders, when the box is ticked", async () => {
    post.mockResolvedValue({ imported: 3, skipped: 0, folders: 2 });
    const { user, input } = await open();
    await user.upload(input(), trashVault());
    await user.click(await screen.findByRole("checkbox", { name: /Also import Obsidian's trash/ }));
    await user.click(screen.getByRole("button",{name:"Start import"}));
    await screen.findByText("3 notes imported");
    expect(sentPaths().sort()).toEqual(["Obsidian 垃圾桶/舊筆記.md", "Obsidian 垃圾桶/課程/草稿.md", "課程/筆記.md"].sort());
    expect(screen.queryByText(/not imported$/)).toBeNull();
  });
  it("offers no trash option when the folder has none", async () => {
    const { user, input } = await open();
    await user.upload(input(), [file()]);
    await screen.findByRole("button",{name:"Start import"});
    expect(screen.queryByRole("checkbox", { name: /Obsidian's trash/ })).toBeNull();
  });
  it("uses the file name when webkitRelativePath is empty", async () => {
    post.mockResolvedValue({ imported: 1, skipped: 0, folders: 0 });
    const { user, input } = await open();
    await user.upload(input(), file("筆記.md"));
    await user.click(await screen.findByRole("button",{name:"Start import"}));
    await screen.findByRole("status");
    expect(JSON.parse(post.mock.calls[0]![1]!.body as string).files[0].path).toBe("筆記.md");
  });
  it("uses the common sign-in error and does not claim a failed upload was rolled back", async () => {
    post.mockRejectedValue(new ApiError(401, "Session expired"));
    const { user, input, onImportDone } = await open();
    await user.upload(input(), file());
    await user.click(await screen.findByRole("button",{name:"Start import"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in again");
    expect(screen.getByRole("alert")).toHaveTextContent("Some files may already be imported");
    expect(onImportDone).not.toHaveBeenCalled();
  });
  it("keeps committed results if refreshing the note list fails", async () => {
    post.mockResolvedValue({ imported: 1, skipped: 0, folders: 1 });
    const { user, input } = await open(vi.fn(() => { throw new Error("Refresh failed"); }));
    await user.upload(input(), file());
    await user.click(await screen.findByRole("button",{name:"Start import"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Import finished");
    expect(screen.getByRole("status")).toHaveTextContent("1 notes imported");
    expect(screen.queryByRole("button", { name: "Choose folder again" })).not.toBeInTheDocument();
  });
  it("reports an unsupported-only selection without sending an empty request", async () => {
    const { user, input } = await open();
    await user.upload(input(), file("Vault/report.enex"));
    expect(await screen.findByRole("status")).toHaveTextContent("1 unsupported files skipped");
    expect(post).not.toHaveBeenCalled();
  });

  it("updates the explicitly selected source and lists conflicts without claiming an update", async () => {
    const existing = {id:"25cc8305-82ad-47a3-a7ec-b48a10b5a8a6",name:"Course archive"};
    list.mockResolvedValue({sources:[existing]});
    post.mockResolvedValue({imported:0,updated:0,skipped:1,folders:0,conflicts:[{path:"課程/筆記.md",reason:"local_changes"}]});
    const {user,input} = await open();
    await user.upload(input(),file());
    await user.selectOptions(screen.getByLabelText("Import destination"),existing.id);
    await user.click(screen.getByRole("button",{name:"Start import"}));
    await screen.findByText("Kept your changes in Onden");
    expect(screen.getByText("課程/筆記.md")).toBeVisible();
    expect(JSON.parse(post.mock.calls[0]![1].body).source).toEqual(existing);
    expect(screen.queryByText(/notes updated/)).not.toBeInTheDocument();
  });

  it("can choose a new source even when the selected folder has the same name", async () => {
    const existing = {id:"25cc8305-82ad-47a3-a7ec-b48a10b5a8a6",name:"Vault"};
    list.mockResolvedValue({sources:[existing]});
    post.mockResolvedValue({imported:1,skipped:0,folders:0});
    const {user,input} = await open();
    await user.upload(input(),file());
    expect(screen.getByLabelText("Import destination")).toHaveValue("new");
    await user.click(screen.getByRole("button",{name:"Start import"}));
    expect(JSON.parse(post.mock.calls[0]![1].body).source.id).not.toBe(existing.id);
  });

  it("keeps the source ID after an uncertain response when retrying the same form", async () => {
    post.mockRejectedValueOnce(new TypeError("Response lost")).mockResolvedValue({imported:0,unchanged:1,skipped:0,folders:0});
    const {user,input} = await open();
    await user.upload(input(),file());
    await user.click(screen.getByRole("button",{name:"Start import"}));
    await screen.findByRole("alert");
    const first = JSON.parse(post.mock.calls[0]![1].body).source;
    await user.click(screen.getByRole("button",{name:"Choose folder again"}));
    await user.upload(input(),file());
    expect(screen.getByLabelText("Import destination")).toHaveValue(first.id);
    await user.click(screen.getByRole("button",{name:"Start import"}));
    await screen.findByText("1 notes unchanged");
    expect(JSON.parse(post.mock.calls[1]![1].body).source).toEqual(first);
  });

  it("canceling file review performs no upload and allows another folder", async () => {
    const {user,input} = await open();
    await user.upload(input(),file());
    await user.click(screen.getByRole("button",{name:"Choose another folder"}));
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole("button",{name:"Choose folder…"})).toBeEnabled();
  });
});
