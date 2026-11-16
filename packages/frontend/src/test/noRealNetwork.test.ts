// The guard in setup.ts: a request nobody stubbed fails the test that made it, naming the URL (helpers/noRealNetwork.ts).
import { describe, expect, it, vi } from "vitest";
import { assertNoRealNetwork } from "./helpers/noRealNetwork";

describe("a unit test never reaches the network", () => {
  it("fetch throws at once and names the URL, even for code that catches it", () => {
    expect(() => fetch("/api/spaces")).toThrow(/Real network request in a test: fetch \/api\/spaces/);
    expect(() => fetch(new URL("http://localhost:3000/api/auth/get-session"))).toThrow(/localhost:3000\/api\/auth\/get-session/);
    // The after-each check still fails the test when the caller swallowed the error.
    expect(() => assertNoRealNetwork()).toThrow(/2 real network request\(s\)[\s\S]*\/api\/spaces[\s\S]*get-session/);
    expect(() => assertNoRealNetwork()).not.toThrow(); // reported once
  });

  it("a stub put on top is used, and undoing it brings the refusal back", async () => {
    vi.stubGlobal("fetch", async () => new Response("answer"));
    expect(await (await fetch("/api/anything")).text()).toBe("answer");
    vi.unstubAllGlobals();
    expect(() => fetch("/api/anything")).toThrow(/Real network request/);
    expect(() => assertNoRealNetwork()).toThrow();
  });

  it.runIf(typeof WebSocket === "function")("a WebSocket and an EventSource are refused too", () => {
    expect(() => new WebSocket("ws://localhost:3000/socket")).toThrow(/new WebSocket ws:\/\/localhost:3000\/socket/);
    if (typeof EventSource === "function") expect(() => new EventSource("/api/events/stream")).toThrow(/new EventSource/);
    expect(() => assertNoRealNetwork()).toThrow();
  });

  it("XMLHttpRequest.send is refused", () => {
    const request = new XMLHttpRequest();
    request.open("GET", "/api/old-style");
    expect(() => request.send()).toThrow(/XMLHttpRequest \/api\/old-style/);
    expect(() => assertNoRealNetwork()).toThrow();
  });
});
