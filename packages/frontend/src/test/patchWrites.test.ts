import { bindAccountStorage } from "../lib/accountStorage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, hashText } from "@onden/markdown";

// Writes that carry a whole value and the value it came from go out as a
// patch (lib/data/patchedBody.ts, sent by writeQueue). A fake server answers
// like the real one: the base is the stored value, or else it is unknown (409).

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/appStore", () => ({ addToast: mocks.toast, getAppState: () => ({ online: false }) }));
vi.mock("../lib/localDb", () => ({
  catchUpWithOtherTabs: vi.fn(), getOldestPendingWriteAt: vi.fn(), addPendingWrite: vi.fn(), getPendingWrites: vi.fn(), clearPendingWrite: vi.fn(), bumpPendingWriteAttempt: vi.fn(), rejectPendingWrite: vi.fn(), storeRejectedWrite: vi.fn(), getRejectedWrites: vi.fn(), dismissRejectedWrite: vi.fn(),
}));

import { ApiError } from "../lib/api";
import { addPendingWrite, getPendingWrites, clearPendingWrite, storeRejectedWrite, type PendingWrite } from "../lib/localDb";
import { submitWrite, flushPendingWrites } from "../lib/data/writeQueue";
import { patchedBody, MIN_PATCH_UNITS } from "../lib/data/patchedBody";
import { setPending } from "../lib/data/syncStatus";

const NOTE = "/api/nodes/4e5b6a52-3c0e-4f53-a0a7-5d1c1d7c0f11";
const line = (i: number) => `Line ${i}: some text of the note that makes it long enough.`;
const lines = (n: number) => Array.from({ length: n }, (_, i) => line(i));
const BASE = lines(300).join("\n");
const withLine = (i: number, text: string) => lines(300).map((l, j) => (j === i ? text : l)).join("\n");
const save = (markdown: string, base_markdown: string) => JSON.stringify({ markdown, base_markdown, title: "T" });

describe("patchedBody", () => {
  it("replaces the value and its base by a patch that gives the value back", () => {
    const next = BASE + "\nnew line";
    const patched = JSON.parse(patchedBody("PATCH", NOTE, save(next, BASE))!);
    expect(patched.markdown).toBeUndefined();
    expect(patched.base_markdown).toBeUndefined();
    expect(patched.title).toBe("T");
    expect(patched.markdown_patch.base_hash).toBe(hashText(BASE));
    expect(applyPatch(BASE, patched.markdown_patch)).toBe(next);
    expect(JSON.stringify(patched).length).toBeLessThan(300);
  });

  it("leaves small values, writes without a base and other requests alone", () => {
    expect(BASE.length).toBeGreaterThan(MIN_PATCH_UNITS);
    expect(patchedBody("PATCH", NOTE, save("short", "shorter"))).toBeNull();
    expect(patchedBody("PATCH", NOTE, JSON.stringify({ markdown: BASE }))).toBeNull();
    expect(patchedBody("PATCH", NOTE, JSON.stringify({ title: "only a title" }))).toBeNull();
    expect(patchedBody("POST", NOTE, save(BASE + "x", BASE))).toBeNull();
    expect(patchedBody("PATCH", "/api/tags/abc", save(BASE + "x", BASE))).toBeNull();
    expect(patchedBody("PATCH", NOTE, "not json")).toBeNull();
    expect(patchedBody("PATCH", NOTE, null)).toBeNull();
  });
});

describe("sending patches", () => {
  let writes: PendingWrite[];
  let stored: string;
  let kept: Set<string>;
  let bodies: Record<string, unknown>[];
  const sawWhole = () => bodies.filter((b) => b.markdown !== undefined).length;

  beforeEach(() => {
    bindAccountStorage("unit-test-account", "");
    vi.resetAllMocks();
    localStorage.clear();
    setPending(0);
    writes = []; bodies = []; stored = BASE; kept = new Set([hashText(BASE)]);
    vi.mocked(getPendingWrites).mockImplementation(async () => [...writes]);
    vi.mocked(addPendingWrite).mockImplementation(async (method, path, body, idem_key) => {
      writes.push({ id: (writes.at(-1)?.id ?? 0) + 1, method, path, body, idem_key: idem_key ?? null, attempts: 0 });
    });
    vi.mocked(clearPendingWrite).mockImplementation(async (id) => { writes = writes.filter((w) => w.id !== id); });
    // Like the real store: a refused save comes back as its row. Left to resetAllMocks it would answer undefined, and the
    // refusal test would leave that hole in writeRecovery's rows for whichever test the shuffle runs next.
    vi.mocked(storeRejectedWrite).mockImplementation(async (request, rejection) => ({ ...request, id: 1000 + bodies.length, attempts: 0, rejection }));
    mocks.api.mockImplementation(async (_path: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { markdown?: string; markdown_patch?: { base_hash: string; hunks: never[] } };
      bodies.push(body);
      if (body.markdown_patch) {
        // like services/patchedValue.ts: the stored value, else a version kept for the note
        if (hashText(stored) !== body.markdown_patch.base_hash && !kept.has(body.markdown_patch.base_hash)) {
          throw new ApiError(409, JSON.stringify({ error: "patch_base_unknown" }));
        }
        // (this fake keeps only the stored text: a kept hash that is not current is not exercised here)
        stored = applyPatch(stored, body.markdown_patch);
      } else stored = body.markdown!;
      kept.add(hashText(stored));
      return { id: "n", markdown: stored };
    });
  });

  it("an online save sends the patch, not the note", async () => {
    const next = withLine(10, "edited");
    await submitWrite({ method: "PATCH", path: NOTE, body: save(next, BASE) });
    expect(stored).toBe(next);
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies[0]).length).toBeLessThan(400);
  });

  it("three saves made offline go out in order as patches once online, ending on the last text", async () => {
    const v1 = withLine(1, "first");
    const v2 = withLine(2, "second");
    const v3 = v2 + "\nthird";
    for (const [value, base] of [[v1, BASE], [v2, v1], [v3, v2]] as const) {
      expect((await submitWrite({ method: "PATCH", path: NOTE, body: save(value, base), online: false })).status).toBe("queued");
    }
    expect(writes).toHaveLength(3);
    // the queue keeps the whole value and its base
    expect(JSON.parse(writes[0]!.body!).markdown).toBe(v1);
    await flushPendingWrites();
    expect(writes).toHaveLength(0);
    expect(bodies).toHaveLength(3);
    expect(sawWhole()).toBe(0);
    expect(stored).toBe(v3);
  });

  it("a base the server cannot give back is answered by the whole save, once, under the same key", async () => {
    stored = withLine(5, "another device"); // saved since; BASE is no longer known
    kept.clear();
    const next = withLine(10, "edited");
    const result = await submitWrite({ method: "PATCH", path: NOTE, body: save(next, BASE), idemKey: "key-1" });
    expect(result.status).toBe("synced");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.markdown_patch).toBeDefined();
    expect(bodies[1]).toMatchObject({ markdown: next, base_markdown: BASE });
    const keys = mocks.api.mock.calls.map((call) => (call[1] as RequestInit).headers as Record<string, string>);
    expect(keys[0]!["Idempotency-Key"]).toBe("key-1");
    expect(keys[1]!["Idempotency-Key"]).toBe("key-1");
  });

  it("other refusals are not retried as a whole save", async () => {
    mocks.api.mockRejectedValueOnce(new ApiError(403, JSON.stringify({ error: "forbidden" })));
    await expect(submitWrite({ method: "PATCH", path: NOTE, body: save(withLine(3, "x"), BASE) })).rejects.toBeInstanceOf(ApiError);
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
});
