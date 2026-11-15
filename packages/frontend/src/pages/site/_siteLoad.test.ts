import { describe, expect, it, vi } from "vitest";
import { createSiteLoader } from "./_siteLoad";

const snapshot = (title: string) => ({ title, home_node_id: null, payload: { nodes: [], edges: [], presentation: {} } });
const ok = (title: string, etag: string | null) =>
  new Response(JSON.stringify(snapshot(title)), { status: 200, headers: etag ? { ETag: etag } : {} });

function loaderWith(...responses: Array<Response | Error>) {
  const queue = [...responses];
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = queue.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  return { load: createSiteLoader(fetchImpl as unknown as typeof fetch, "http://api"), fetchImpl };
}
const titleOf = (r: Awaited<ReturnType<ReturnType<typeof createSiteLoader>>>) => (r.kind === "ok" ? r.data.title : null);

describe("loadSite", () => {
  it("asks without a validator first, then reuses the kept copy on 304", async () => {
    const { load, fetchImpl } = loaderWith(ok("A", '"v1"'), new Response(null, { status: 304 }));
    const first = await load();
    const second = await load();
    expect(fetchImpl.mock.calls[0]![1]).toBeUndefined();
    expect(fetchImpl.mock.calls[1]![1]).toEqual({ headers: { "If-None-Match": '"v1"' } });
    expect(second.kind === "ok" && first.kind === "ok" && second.data === first.data).toBe(true); // the same shaped copy, not parsed again
  });

  it("takes the new copy on 200 and validates against its ETag next", async () => {
    const { load, fetchImpl } = loaderWith(ok("A", '"v1"'), ok("B", '"v2"'), new Response(null, { status: 304 }));
    await load();
    expect(titleOf(await load())).toBe("B");
    expect(titleOf(await load())).toBe("B");
    expect(fetchImpl.mock.calls[2]![1]).toEqual({ headers: { "If-None-Match": '"v2"' } });
  });

  it("reports an error when the API fails, and does not answer from a copy the server did not confirm", async () => {
    const { load } = loaderWith(ok("A", '"v1"'), new Response("boom", { status: 500 }), new Response(null, { status: 304 }), new Error("down"));
    await load();
    expect((await load()).kind).toBe("error");
    expect((await load()).kind).toBe("error"); // 304 with nothing kept is not usable
    expect((await load()).kind).toBe("error"); // unreachable
  });

  it("keeps no copy when the server sends no ETag", async () => {
    const { load, fetchImpl } = loaderWith(ok("A", null), ok("B", null));
    await load();
    expect(titleOf(await load())).toBe("B");
    expect(fetchImpl.mock.calls[1]![1]).toBeUndefined();
  });
});
