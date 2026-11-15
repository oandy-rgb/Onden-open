import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsModal from "../settings/SettingsModal";
import { api, ApiError, noWorkspaceData } from "../lib/api";
import { getAppState, resetAppState } from "../lib/appStore";
import { workspaceWriter } from "../lib/data/domainWriters";
// Online decisions check the local write queue first (onlineWrite.ts); jsdom has no DB worker.
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));

// Settings ▸ Your Data ▸ Import a tag pack installs through installTagPack, the same
// operation as the welcome card and 「＋ 新增標籤」: a pack that declares a
// module (an exported #複習 declares review) brings that module with it. It
// used to post /api/tags/import itself and leave the module out.

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn(async () => ({})) }));
vi.mock("../lib/data/domainWriters", async (load) => {
  const actual = await load<typeof import("../lib/data/domainWriters")>();
  return { ...actual, workspaceWriter: { ...actual.workspaceWriter, setModuleImported: vi.fn() } };
});

const reviewPack = JSON.stringify({ format: "onden.tagpack/v1", name: "複習", modules: ["review"], fields: [] });

async function importFile(contents: string) {
  const { baseElement: container } = render(<SettingsModal online onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /data and backup/i }));
  // Importing a tag pack is an advanced setting (settings/registry.tsx).
  await user.click(screen.getByRole("button", { name: "Show advanced settings" }));
  const input = container.querySelector<HTMLInputElement>("input[type=file][accept*='tagpack']")!;
  await user.upload(input, new File([contents], "review.tagpack.json", { type: "application/json" }));
}

afterEach(() => { vi.mocked(api).mockReset(); vi.mocked(workspaceWriter.setModuleImported).mockReset(); resetAppState(); });

describe("installing a tag pack from Settings", () => {
  it("installs the pack without importing its modules, and says which to import in Settings › Modules", async () => {
    resetAppState({ data: { ...noWorkspaceData, workspace: { ...noWorkspaceData.workspace, modules: [] } }, online: true });
    vi.mocked(api).mockResolvedValue({ id: "t1", name: "複習" } as never);
    vi.mocked(workspaceWriter.setModuleImported).mockResolvedValue({ modules: ["review"], moduleTagId: null });
    await importFile(reviewPack);
    expect(await screen.findByText(/installed as #複習/)).toBeInTheDocument();
    // One online operation: the install carries an Idempotency-Key (a retry applies once).
    const [, init] = vi.mocked(api).mock.calls.find(([path]) => path === "/api/tags/import")!;
    expect(init).toMatchObject({ method: "POST", body: reviewPack });
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBeTruthy();
    expect(workspaceWriter.setModuleImported).not.toHaveBeenCalled();
    expect(getAppState().toasts.map((toast) => toast.message).join(" ")).toMatch(/needs 「Review」\. Turn it on in Settings › Modules/);
  });

  it("explains a refusal in plain words", async () => {
    resetAppState({ data: { ...noWorkspaceData, workspace: { ...noWorkspaceData.workspace, modules: [] } }, online: true });
    vi.mocked(api).mockRejectedValue(new ApiError(403, JSON.stringify({ error: "forbidden" })));
    await importFile(reviewPack);
    expect(await screen.findByText(/You don't have permission to do that\./)).toBeInTheDocument();
    expect(workspaceWriter.setModuleImported).not.toHaveBeenCalled();
  });
});
