import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async original => ({ ...await original<typeof import("../lib/api")>(), api: mock.api }));
vi.mock("../lib/localDb", () => ({
  upsertNode: async () => {}, removeNode: async () => {},
  getPendingWrites: async () => [], getRejectedWrites: async () => [],
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 701, attempts: 0, rejection }),
}));
import { useCardDraft, type SaveCardBody } from "../hooks/useCardDraft";
import { makeNoteWriter } from "../lib/data/noteWriter";
import { getRecoveryWrites, refreshRecoveryWrites } from "../lib/data/writeRecovery";
import { ApiError,  type Bootstrap, type ContentNode } from "../lib/api";
import { addToast, getAppState, resetAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { ownerData } from "./ownerData";

beforeEach(async () => {
  bindAccountStorage("card-recovery-test", "");
  localStorage.clear(); resetAppState(); mock.api.mockReset(); await refreshRecoveryWrites();
});
afterEach(cleanup);

it.each([false, true])("retains a card's directly refused text outside its mount (leave before response: %s)", async leaveBeforeResponse => {
  const node: ContentNode = { id: "note", title: "Note", markdown: "accepted text", slug: "note", node_type: "content", source_type: "manual" };
  let data: Bootstrap = { ...ownerData, nodes: [node] };
  let reject!: (error: Error) => void;
  mock.api.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const writer = makeNoteWriter({
    get data() { return data; }, online: true,
    setData: update => { data = typeof update === "function" ? update(data) : update; },
    addToast, scheduleUserFolderSync: () => {}, refresh: async () => {},
  });
  // A card saves its body on the base it was edited from (useBoardWorkspace).
  const save: SaveCardBody = (id, content, { base, keepalive }) => writer.patch(id, { markdown: content }, { baseMarkdown: base, keepalive });
  const card = renderHook(() => useCardDraft(node.id, data.nodes[0].markdown, save));
  let saving!: Promise<boolean>;
  act(() => { card.result.current.edit("refused card draft"); saving = card.result.current.flush(); });
  await vi.waitFor(() => expect(mock.api).toHaveBeenCalledOnce());
  if (leaveBeforeResponse) card.unmount();
  await act(async () => { reject(new ApiError(403, "Denied")); expect(await saving).toBe(false); });
  if (!leaveBeforeResponse) {
    expect(card.result.current.content).toBe("refused card draft");
    expect(card.result.current.status).toBe("rejected");
    card.unmount();
  }
  const reopened = renderHook(() => useCardDraft(node.id, data.nodes[0].markdown, save));
  expect(reopened.result.current.content).toBe("accepted text");
  expect(getRecoveryWrites()).toEqual([expect.objectContaining({ text: "refused card draft", rejection: expect.any(String) })]);
  expect(mock.api).toHaveBeenCalledOnce();
  expect(getAppState().toasts).toHaveLength(0); // the recovery entry is the notification
});
