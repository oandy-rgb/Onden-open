// The page's side of the sync protocol (lib/protocolGate.ts, wired in lib/api.ts): once the server says this page is
// too old (426), or says it speaks a protocol older than this page accepts, no write leaves the page; reads still go
// out, and an updated server's answer lifts the stop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_PROTOCOL, SERVER_PROTOCOL_HEADER } from "@onden/markdown";
import { ApiError, apiFetch } from "../lib/api";
import { PROTOCOL_PROBE_DELAYS_MS, currentProtocolBlock, onProtocolBlockChange, resetProtocolGate } from "../lib/protocolGate";

const reply = (status: number, serverProtocol?: number) =>
  new Response("{}", { status, headers: serverProtocol === undefined ? {} : { [SERVER_PROTOCOL_HEADER]: String(serverProtocol) } });
const OLDER_SERVER = CLIENT_PROTOCOL - 1;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetProtocolGate();
  fetchMock = vi.fn(async () => reply(200, CLIENT_PROTOCOL));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const SYNC_REQUESTS: Array<[string, RequestInit | undefined]> = [
  ["/api/sync", { method: "POST", body: "{}" }],
  ["/api/sync/bodies", { method: "POST", body: "{}" }],
  ["/api/sync/drawings", { method: "POST", body: "{}" }],
  ["/api/sync/drawings", undefined],
  ["/api/sync/membership?cursor=x", undefined],
  ["/api/sync/membership/digest", undefined],
  ["/api/bootstrap?bodies=none", undefined],
];

describe("a server older than this page accepts", () => {
  async function learnServerIsOld() {
    fetchMock.mockResolvedValueOnce(reply(200, OLDER_SERVER));
    await apiFetch("/api/me");
    expect(currentProtocolBlock()).toBe("server_old");
    fetchMock.mockClear();
  }

  it("holds every write and every sync request before the network, whatever its method; other reads still go out", async () => {
    await learnServerIsOld();
    const writes: Array<[string, RequestInit]> = [["/api/nodes/n", { method: "PATCH", body: "{}" }], ["/api/tags", { method: "POST", body: "{}" }], ["/api/nodes/n", { method: "DELETE" }]];
    for (const [path, init] of [...writes, ...SYNC_REQUESTS]) {
      const refused = await apiFetch(path, init).catch((error: unknown) => error);
      expect(refused, path).toBeInstanceOf(ApiError);
      expect(refused, path).toMatchObject({ status: 426, code: "server_too_old" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await apiFetch("/api/me");
    await apiFetch("/api/nodes/n");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not use the first sync answer of a server that turns out to be too old", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, OLDER_SERVER));
    await expect(apiFetch("/api/bootstrap")).rejects.toMatchObject({ status: 426, code: "server_too_old" });
    expect(currentProtocolBlock()).toBe("server_old");
  });

  it("lifts the stop when a non-sync answer carries an accepted protocol, and says so", async () => {
    const seen: Array<string | null> = [];
    const stop = onProtocolBlockChange((block) => seen.push(block));
    await learnServerIsOld();
    await apiFetch("/api/me");
    expect(currentProtocolBlock()).toBeNull();
    stop();
    expect(seen).toEqual(["server_old", null]);
    await apiFetch("/api/nodes/n", { method: "PATCH", body: "{}" });
    await apiFetch("/api/sync", { method: "POST", body: "{}" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("asks the server by itself while stopped, so a page nobody touches still finds out it was updated", async () => {
    vi.useFakeTimers();
    try {
      await learnServerIsOld();
      fetchMock.mockResolvedValue(reply(200, OLDER_SERVER));
      await vi.advanceTimersByTimeAsync(PROTOCOL_PROBE_DELAYS_MS[0]! + 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/me");
      expect(currentProtocolBlock()).toBe("server_old"); // still old: it asks again later
      await vi.advanceTimersByTimeAsync(PROTOCOL_PROBE_DELAYS_MS[1]! + 1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      fetchMock.mockResolvedValue(reply(200, CLIENT_PROTOCOL)); // the server was updated
      await vi.advanceTimersByTimeAsync(PROTOCOL_PROBE_DELAYS_MS[2]! + 1);
      expect(currentProtocolBlock()).toBeNull();
      const asked = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(fetchMock.mock.calls.length).toBe(asked); // it stops asking once the stop is lifted
    } finally { vi.useRealTimers(); }
  });

  it("does not take a gateway's error page for the server's answer", async () => {
    await learnServerIsOld();
    fetchMock.mockResolvedValueOnce(reply(502));
    await apiFetch("/api/me");
    expect(currentProtocolBlock()).toBe("server_old");
  });
});

describe("a server of a newer protocol", () => {
  it("makes this page the old one: reload offered, writes and sync held, reads go out, and only a reload ends it", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, CLIENT_PROTOCOL + 1));
    await apiFetch("/api/me");
    expect(currentProtocolBlock()).toBe("page_old");
    fetchMock.mockClear();
    for (const [path, init] of [["/api/nodes/n", { method: "PATCH", body: "{}" }], ["/api/sync", { method: "POST", body: "{}" }], ["/api/bootstrap", undefined]] as Array<[string, RequestInit | undefined]>) {
      await expect(apiFetch(path, init)).rejects.toMatchObject({ status: 426, code: "client_too_old" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await apiFetch("/api/me"); // reads go out; an answer with the same protocol does not lift it
    fetchMock.mockResolvedValue(reply(200, CLIENT_PROTOCOL));
    await apiFetch("/api/me");
    expect(currentProtocolBlock()).toBe("page_old");
  });

  it("does not use its first sync answer", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, CLIENT_PROTOCOL + 1));
    await expect(apiFetch("/api/sync", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "client_too_old" });
  });
});

describe("the same protocol changes nothing", () => {
  it("never stops a page whose server speaks its protocol, or a server that sends no header", async () => {
    await apiFetch("/api/me");
    fetchMock.mockResolvedValueOnce(reply(200));
    await apiFetch("/api/me");
    expect(currentProtocolBlock()).toBeNull();
    fetchMock.mockClear();
    await apiFetch("/api/nodes/n", { method: "DELETE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("a page the server refused as too old (426)", () => {
  it("sends no more writes until it is reloaded, and a later answer does not lift it", async () => {
    fetchMock.mockResolvedValueOnce(reply(426, CLIENT_PROTOCOL));
    await apiFetch("/api/nodes/n", { method: "PATCH", body: "{}" });
    expect(currentProtocolBlock()).toBe("page_old");
    fetchMock.mockClear();
    await expect(apiFetch("/api/nodes/n", { method: "PATCH", body: "{}" })).rejects.toMatchObject({ status: 426, code: "client_too_old" });
    await apiFetch("/api/me");
    await expect(apiFetch("/api/sync", { method: "POST", body: "{}" })).rejects.toMatchObject({ status: 426, code: "client_too_old" });
    expect(currentProtocolBlock()).toBe("page_old");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
