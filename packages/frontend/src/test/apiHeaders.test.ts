import { afterEach, expect, it, vi } from "vitest";
import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER } from "@onden/markdown";
import { api, apiFetch } from "../lib/api";

afterEach(() => vi.unstubAllGlobals());

it.each([
  { accept: "text/plain", "X-Test": "retained" },
  new Headers({ accept: "text/plain", "X-Test": "retained" }),
  [["accept", "text/plain"], ["X-Test", "retained"]] as [string, string][],
])("preserves RequestInit header formats and reads requested plain text", async (headers) => {
  const fetchMock = vi.fn(async () => new Response("plain text"));
  vi.stubGlobal("fetch", fetchMock);
  await expect(api("/api/export", { headers })).resolves.toBe("plain text");
  const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
  const sent = new Headers(init.headers);
  expect(sent.get("X-Test")).toBe("retained");
  expect(sent.get("Content-Type")).toBe("application/json");
  expect(init.credentials).toBe("include");
});

it("every request says which edition of the contract this page speaks (the server refuses a note write from an older one)", async () => {
  const fetchMock = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  await api("/api/nodes/n", { method: "PATCH", body: "{}" });
  await apiFetch("/api/health");
  const sent = fetchMock.mock.calls.map((call) => new Headers((call as unknown as [string, RequestInit])[1].headers));
  expect(sent).toHaveLength(2);
  for (const headers of sent) expect(headers.get(CLIENT_PROTOCOL_HEADER)).toBe(String(CLIENT_PROTOCOL));
});
