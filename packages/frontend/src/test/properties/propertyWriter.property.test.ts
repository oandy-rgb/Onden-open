// What propertyWriter.set puts on the wire (scan 06 M1): a type or flag the
// caller did not name is not sent, so the server keeps the row's own. Random
// option combinations; the request body has exactly the keys that were named.

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../lib/api", async (original) => ({ ...await original<typeof import("../../lib/api")>(), api: mocks.api }));
vi.mock("../../lib/localDb", () => ({
  storeRejectedWrite: async (request: unknown, rejection: string) => ({ ...(request as object), id: 901, attempts: 0, rejection }),
  upsertNode: vi.fn(), removeNode: vi.fn(), upsertAttribute: vi.fn(), removeAttribute: vi.fn(),
  getNodeAttributeRecord: vi.fn(async () => null), addPendingWrite: vi.fn(), getPendingWrites: vi.fn(),
}));
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { noWorkspaceData, type Bootstrap } from "../../lib/api";
import * as db from "../../lib/localDb";
import { setPending } from "../../lib/data/syncStatus";
import { makePropertyWriter } from "../../lib/data/propertyWriter";
import type { DataCtx } from "../../lib/data/types";

function ctx(): DataCtx {
  let state: Bootstrap = { ...noWorkspaceData, nodes: [{ id: "n1", title: "N", slug: "n", markdown: "", node_type: "content", source_type: "manual", attrs: { status: "open" } }] };
  return { get data() { return state; }, online: true, setData: (u) => { state = typeof u === "function" ? u(state) : u; }, addToast: vi.fn(), scheduleUserFolderSync: vi.fn(), refresh: vi.fn(async () => {}) };
}
async function sentBody(opts?: { value_type?: string; is_inheritable?: boolean }): Promise<Record<string, unknown>> {
  mocks.api.mockClear();
  mocks.api.mockResolvedValue({ key: "status", value: "done", value_type: "text", is_inheritable: true, source: "ui" });
  await makePropertyWriter(ctx()).set("n1", "status", "done", opts);
  const call = mocks.api.mock.calls.find(([path]) => String(path).includes("/attributes/status"));
  return JSON.parse((call![1] as { body: string }).body);
}

beforeEach(() => {
  vi.mocked(db.getPendingWrites).mockResolvedValue([]);
  vi.mocked(db.getNodeAttributeRecord).mockResolvedValue(null);
  setPending(0);
});

describe("propertyWriter.set request body", () => {
  it("a plain value edit sends neither type nor flag (kanban drag, M1)", async () => {
    const body = await sentBody();
    expect(body).not.toHaveProperty("value_type");
    expect(body).not.toHaveProperty("is_inheritable");
  });

  it("random option combinations: the body names exactly what the caller named", async () => {
    const opts = fc.record({ value_type: fc.constantFrom("text", "number"), is_inheritable: fc.boolean() }, { requiredKeys: [] });
    await fc.assert(fc.asyncProperty(opts, async (o) => {
      const body = await sentBody(o);
      expect(Object.hasOwn(body, "value_type")).toBe(o.value_type !== undefined);
      expect(Object.hasOwn(body, "is_inheritable")).toBe(o.is_inheritable !== undefined);
      if (o.is_inheritable !== undefined) expect(body.is_inheritable).toBe(o.is_inheritable);
    }), { numRuns: Math.min(PROPS_RUNS, 25), seed: PROPS_SEED });
  });
});
