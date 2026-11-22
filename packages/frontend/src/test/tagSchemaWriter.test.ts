import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/localDb", () => ({
  upsertNode: vi.fn(), addPendingWrite: vi.fn(), getPendingWrites: vi.fn(async () => []), clearPendingWrite: vi.fn(async () => {}),
  storeRejectedWrite: vi.fn(async (request, rejection) => ({ ...request, id: 301, attempts: 0, rejection })),
}));

import { ApiError, type Tag } from "../lib/api";
import { addPendingWrite, getPendingWrites, clearPendingWrite } from "../lib/localDb";
import { makeTagSchemaWriter } from "../lib/data/tagSchemaWriter";
import { memoryQueue } from "./helpers/memoryQueue";
import { ownerData } from "./ownerData";
import { sharedRowsOver } from "../lib/data/storeOps";
import { setPending } from "../lib/data/syncStatus";
import type { DataCtx } from "../lib/data/types";

type Field = { name: string; type: string; options?: string[] };
const TAG = "tag-1";
let queue: { rows: { body: string | null }[] };

/** The live store, as a call site sees it: it builds the next whole `fields` array from `data.tags`. */
function harness(online: boolean) {
  let state: typeof ownerData = { ...ownerData, tags: [{ id: TAG, name: "book", color: "", schema_id: null, schema_fields: [] as Field[], schema_behaviour: {} } as unknown as Tag] };
  const ctx: DataCtx = {
    get data() { return state; }, online,
    setData: (update) => { state = typeof update === "function" ? update(state) : update; },
    addToast: vi.fn(), scheduleUserFolderSync: vi.fn(), refresh: vi.fn(async () => {}),
  };
  const writer = makeTagSchemaWriter(ctx);
  const serverCopyOfTags = (tags: Tag[]) => sharedRowsOver(state, { tags }, []).tags!;
  const fieldsInStore = () => (state.tags![0] as unknown as { schema_fields: Field[] }).schema_fields;
  // What InfoTagsTab.makeField does: the new list comes from the store's current copy.
  const addField = (name: string) => writer.update(TAG, { fields: [...fieldsInStore(), { name, type: "text" }] });
  // What NodeAttributesPanel.addSelectOption does.
  const addOption = (field: string, option: string) => writer.update(TAG, {
    fields: fieldsInStore().map((f) => f.name === field ? { ...f, options: [...(f.options ?? []), option] } : f),
  });
  return { writer, fieldsInStore, serverCopyOfTags, tagRow: () => state.tags![0]!, addField, addOption, setFields: (fields: Field[]) => { state = { ...state, tags: [{ ...(state.tags![0] as object), schema_fields: fields } as unknown as Tag] }; } };
}
const names = (body: string | null) => (JSON.parse(body ?? "{}").fields as Field[]).map((f) => f.name);
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockReset();
  queue = memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
  setPending(0);
});

describe("tag schema writer: a whole-list save is built from the latest copy", () => {
  it("offline: two fields added in a row both reach the queue's last save", async () => {
    const h = harness(false);
    expect(await h.addField("Pages")).toEqual({ status: "queued" });
    expect(await h.addField("Author")).toEqual({ status: "queued" });
    expect(queue.rows.map((row) => names(row.body))).toEqual([["Pages"], ["Pages", "Author"]]);
    expect(h.fieldsInStore().map((f) => f.name)).toEqual(["Pages", "Author"]);
  });

  it("offline: two options added in a row both reach the queue's last save", async () => {
    const h = harness(false);
    h.setFields([{ name: "Status", type: "select", options: [] }]);
    await h.addOption("Status", "todo");
    await h.addOption("Status", "done");
    const last = JSON.parse(queue.rows.at(-1)!.body!).fields as Field[];
    expect(last[0]!.options).toEqual(["todo", "done"]);
  });

  it("the first save is refused, the second is accepted: the store keeps what the server holds", async () => {
    const h = harness(true);
    const first = deferred<unknown>();
    mocks.api.mockImplementationOnce(() => first.promise).mockResolvedValueOnce({});
    const a = h.addField("Pages").catch(() => "refused");
    const b = h.addField("Author");
    first.reject(new ApiError(400, "bad"));
    expect(await a).toBe("refused");
    expect(await b).toEqual({ status: "synced", value: {} });
    expect(names(mocks.api.mock.calls[1]![1].body)).toEqual(["Pages", "Author"]);
    expect(h.fieldsInStore().map((f) => f.name)).toEqual(["Pages", "Author"]);
  });

  it("both saves are refused: the store goes back to the original, not to the first refused value", async () => {
    const h = harness(true);
    const first = deferred<unknown>(); const second = deferred<unknown>();
    mocks.api.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const a = h.addField("Pages").catch(() => "refused");
    const b = h.addField("Author").catch(() => "refused");
    first.reject(new ApiError(400, "bad"));
    await a;
    second.reject(new ApiError(400, "bad"));
    await b;
    expect(h.fieldsInStore()).toEqual([]);
  });

  it("a tag list read before the save was answered does not take the new fields away (the store's one door)", () => {
    const h = harness(true);
    const first = deferred<unknown>();
    mocks.api.mockImplementationOnce(() => first.promise);
    const saved = h.addField("Pages");
    const olderCopy = { ...h.tagRow(), schema_fields: [] } as unknown as Tag;
    const [kept] = h.serverCopyOfTags([olderCopy]);
    expect((kept as unknown as { schema_fields: Field[] }).schema_fields.map((f) => f.name)).toEqual(["Pages"]);
    first.resolve({});
    return saved; // answered, so the write lane of this tag is free for the next test
  });
});
