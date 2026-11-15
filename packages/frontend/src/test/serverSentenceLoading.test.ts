import { beforeEach, describe, expect, it, vi } from "vitest";

// The sentence-keyed refusal wording is fetched on first use (keeps it out of boot JS).
describe("sentence wording loads on demand", () => {
  beforeEach(() => { vi.doUnmock("../lib/serverSentences"); vi.resetModules(); });

  const body = JSON.stringify({ error: "node is not deleted" });

  it("reads the generic message until the chunk is loaded, then the plain sentence", async () => {
    const { setLocalePref, registerDictionary } = await import("../lib/i18n");
    registerDictionary("zh-TW", (await import("../lib/i18n.zh-TW")).ZH_TW);
    const { ensureSentenceWording, serverErrorMessage } = await import("../lib/serverErrors");
    setLocalePref("zh-TW");
    expect(serverErrorMessage("node is not deleted", undefined)).toBe("伺服器發生錯誤。");
    await ensureSentenceWording(body);
    expect(serverErrorMessage("node is not deleted", undefined)).toBe("這篇筆記已經不在已刪除裡了。");
    setLocalePref("en");
  });

  it("an ApiError built from a response is right at once", async () => {
    const { setLocalePref, registerDictionary } = await import("../lib/i18n");
    registerDictionary("zh-TW", (await import("../lib/i18n.zh-TW")).ZH_TW);
    const { ApiError, readErrorBody } = await import("../lib/api");
    setLocalePref("zh-TW");
    const response = new Response(body, { status: 409 });
    expect(new ApiError(409, await readErrorBody(response)).message).toBe("這篇筆記已經不在已刪除裡了。");
    setLocalePref("en");
  });

  it("a coded refusal needs no load", async () => {
    const { ensureSentenceWording } = await import("../lib/serverErrors");
    const spy = vi.fn();
    vi.doMock("../lib/serverSentences", () => { spy(); return {}; });
    await ensureSentenceWording(JSON.stringify({ error: "forbidden" }));
    expect(spy).not.toHaveBeenCalled();
  });
});
