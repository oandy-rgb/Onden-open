// The REAL backend behind a controllable, faulty network, for the multi-device
// sync simulation (test/properties/syncFaultSimulation.integration.property.test.ts).
//
// tabWorld.ts runs the real client stack (noteWriter → writeQueue → localDb →
// sql.js worker → syncEngine) against a hand-written fake server. Here the fake
// is replaced: `fetch` goes to the backend's own `app` (Hono, on a real
// Postgres), so the server side of every rule — Idempotency-Key, patch bases
// (`invalid_have`/`patch_base_unknown`), three-way body merge, move/cycle
// refusal, delete/undelete cascades, sync deltas — is the shipped code.
//
// A request waits "on the wire" until the test decides its fate (`respond`):
//   deliver  the server handles it, the client gets the answer
//   net      the request never arrives (a dropped request)
//   lose     the server handled it, the answer never reaches the client
//   503      a proxy answers instead of the server
//   dup      the request arrives twice at once (a duplicate delivery), the first answer is returned
//   arrive   the server handles it now, the answer stays on the wire (a late answer / reordering)
// and a request nobody answers is a "fake online" connection: the client's own
// 25 s attempt deadline ends it (time moves with World.advance). `down` makes
// every request fail at once, like a server that is off.
//
// What a device sends is what the server gets: the request's own headers travel with it (X-Onden-Client-Protocol,
// X-Onden-Device-Id, Idempotency-Key, …), plus the two things a browser adds by itself — the page's Origin and the
// session cookie (the cookie is the test's mocked auth: every request is the one signed-in person). So the server's
// gates for a page (CSRF origin guard, clientGate's 426 for an old page) are in the path, as in the app.
// Needs `// @vitest-environment jsdom` (or node) in the test file: happy-dom's Request drops the Origin header,
// as a browser's page script would be made to.
//
// This file imports no app module at the top level (tabs import theirs after
// vi.resetModules); the backend `app` is handed in by the test.

import { vi } from "vitest";
import { World, tabContext, type Tab } from "./tabWorld";

type App = { request: (path: string, init: RequestInit) => Response | Promise<Response> };
export type Fate = "deliver" | "net" | "lose" | "503" | "dup" | "arrive";
/** `headers`: the server's response headers, passed on as they are (a write's event position, where a read was taken). */
type Captured = { status: number; text: string; contentType: string; headers: Headers };
export type WireRequest = {
  id: number; tab: Tab; method: string; path: string; body: string | null; key: string | null; keepalive: boolean;
  /** The headers the device's own code put on the request (lib/api.ts apiFetch). */
  headers: Headers;
  state: "inflight" | "done"; abandoned: boolean; arrived: boolean; work?: Promise<Captured>;
  resolve(response: Response): void; reject(error: unknown): void;
};
/** What the server actually received (an answered duplicate counts once per arrival). */
export type Handled = { seq: number; device: string; method: string; path: string; body: string | null; key: string | null; status: number; reply: string; duplicate: boolean };

const netError = () => new TypeError("Failed to fetch");

export class RealBackend {
  requests: WireRequest[] = [];
  handled: Handled[] = [];
  log: string[] = [];
  /** A server that is off: every request fails at once, nothing arrives. */
  down = false;
  private seq = 0;
  /** The server handles one request at a time (the order of arrival is the test's choice, so a failure replays). */
  private tail: Promise<unknown> = Promise.resolve();

  /** `login`: the one account every device is signed in to (the id the mocked session answers with), and the Origin
   *  of the page. A device is its own storage scope here (tab.account, so each has its own local copy and locks);
   *  the app names that scope in X-Onden-Expected-User, and on a real device it is the login's id. */
  constructor(private readonly app: App, private readonly login: { userId: string; origin: string }) {}

  reset(): void { this.requests = []; this.handled = []; this.log = []; this.down = false; this.seq = 0; this.tail = Promise.resolve(); }

  // The surface World uses (kill) and the fetch stub.
  get inflight(): WireRequest[] { return this.requests.filter((r) => r.state === "inflight" && !r.tab.dead); }
  get open(): WireRequest[] { return this.requests.filter((r) => r.state === "inflight"); }

  fetch(tab: Tab, input: string, init: RequestInit = {}): Promise<Response> {
    if (tab.dead) return new Promise(() => {}); // a closed page sends nothing
    if (this.down) return Promise.reject(netError());
    const headers = new Headers(init.headers);
    return new Promise<Response>((resolve, reject) => {
      const req: WireRequest = {
        id: ++this.seq, tab, method: (init.method ?? "GET").toUpperCase(), path: input, body: typeof init.body === "string" ? init.body : null,
        key: headers.get("Idempotency-Key"), keepalive: init.keepalive === true, headers, state: "inflight", abandoned: false, arrived: false, resolve, reject,
      };
      init.signal?.addEventListener("abort", () => {
        req.abandoned = true;
        this.log.push(`#${req.id} ${tab.name} gave up (deadline)`);
        if (req.state === "inflight") { req.state = "done"; reject((init.signal as AbortSignal).reason); }
      });
      this.log.push(`#${req.id} ${tab.name} sends ${req.method} ${req.path}${req.key ? ` key=${req.key.slice(-4)}` : ""}${req.body ? ` ${req.body.slice(0, 60)}` : ""}`);
      this.requests.push(req);
    });
  }

  /** The server handles the request (once per call; `again` is a duplicate delivery). */
  arrive(req: WireRequest, again = false): Promise<Captured> {
    if (req.work && !again) return req.work;
    req.arrived = true;
    const run = async (): Promise<Captured> => {
      const headers = new Headers(req.headers);
      headers.set("origin", this.login.origin);
      const scope = headers.get("X-Onden-Expected-User");
      if (scope !== null) {
        if (scope !== req.tab.account) throw new Error(`realBackendWorld: ${req.tab.name} sent X-Onden-Expected-User ${scope}, its storage scope is ${req.tab.account}`);
        headers.set("X-Onden-Expected-User", this.login.userId);
      }
      if (req.body !== null && !headers.has("content-type")) headers.set("content-type", "application/json");
      const res = await this.app.request(req.path, { method: req.method, headers, body: req.body ?? undefined });
      const captured = { status: res.status, text: await res.text(), contentType: res.headers.get("content-type") ?? "application/json", headers: new Headers(res.headers) };
      this.log.push(`#${req.id} handled${again ? " again (duplicate)" : ""}: ${captured.status}${captured.status >= 400 ? ` ${captured.text.slice(0, 80)}` : ""}`);
      this.handled.push({ seq: this.handled.length, device: req.tab.account, method: req.method, path: req.path, body: req.body, key: req.key, status: captured.status, reply: captured.text, duplicate: again });
      return captured;
    };
    const work = this.tail.then(run, run);
    this.tail = work.catch(() => {});
    if (!again) req.work = work;
    return work;
  }

  async respond(req: WireRequest, fate: Fate): Promise<void> {
    if (req.state !== "inflight") return;
    const effective: Fate = this.down && fate !== "lose" ? "net" : fate;
    this.log.push(`#${req.id} ${req.tab.name} -> ${effective}${req.abandoned ? " (abandoned)" : ""}`);
    const tab = req.tab;
    const fail = (error: unknown) => { req.state = "done"; if (!tab.dead) req.reject(error); };
    switch (effective) {
      case "net": fail(netError()); return;
      case "503": req.state = "done"; if (!tab.dead) req.resolve(new Response('{"error":"unavailable"}', { status: 503, headers: { "content-type": "application/json" } })); return;
      case "arrive": await this.arrive(req); return;
      case "lose": await this.arrive(req); fail(netError()); return;
      case "dup": {
        const [first] = await Promise.all([this.arrive(req), this.arrive(req, true)]);
        this.answer(req, first);
        return;
      }
      case "deliver": this.answer(req, await this.arrive(req)); return;
    }
  }

  private answer(req: WireRequest, captured: Captured): void {
    if (req.state !== "inflight") return; // the client gave up while the server was working
    req.state = "done";
    if (!req.tab.dead) req.resolve(new Response(captured.status === 204 ? null : captured.text, { status: captured.status, headers: captured.headers }));
  }
}

/** tabWorld's World with `fetch` wired to a RealBackend. Devices are tabs of different accounts scopes (own local copy, own Web Locks). */
export class RealBackendWorld extends World {
  readonly backend: RealBackend;
  constructor(app: App, login: { userId: string; origin: string }) {
    super();
    this.backend = new RealBackend(app, login);
    // World's own fake server is never used: kill() only needs requests/arrive from it.
    (this as unknown as { server: unknown }).server = this.backend;
  }

  override install(): void {
    super.install();
    this.backend.reset();
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const tab = tabContext.getStore();
      if (!tab) throw new Error("realBackendWorld: a fetch outside a tab's context");
      return this.backend.fetch(tab, String(input), init);
    });
  }
}
