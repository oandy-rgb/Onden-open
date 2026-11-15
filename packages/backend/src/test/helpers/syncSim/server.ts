// The controllable network between a simulated device and the REAL backend:
// every request is either delivered, lost before the server saw it, applied
// with its reply lost (the case an Idempotency-Key exists for), or DELAYED: the
// device hears nothing (it treats it as a network error and retries with the
// same key), and the original reaches the server later, in any order relative
// to what other devices and the device's own retry sent in between (the idea
// of distSim/network.ts: delay and reordering are one thing, "take any pending
// message"). The reply of a delayed request goes nowhere.
import type { PendingWrite } from "./client.js";

export type Fate = "deliver" | "lose_request" | "lose_response" | "delay";
export type Reply = { status: number; body: unknown };
/** Every request the server actually received, in the order it handled them. */
export type Handled = { seq: number; client: string; method: string; path: string; body: Record<string, unknown> | null; idemKey: string; status: number; replyLost: boolean; reply: unknown };

type App = { request: (path: string, init: RequestInit) => Response | Promise<Response> };

type InFlight = { client: string; write: PendingWrite; who: Record<string, string> };

export class SimServer {
  readonly handled: Handled[] = [];
  /** Delayed requests on the wire, in the order they were sent. */
  readonly inFlight: InFlight[] = [];
  constructor(private readonly app: App) {}

  async call(method: string, path: string, json?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    // The native-origin actor (index.ts) is the one account both devices use.
    const res = await this.app.request(path, {
      method,
      // The app's request wrapper (frontend lib/api.ts) names the device's clock at the moment of sending.
      headers: { origin: "http://localhost", "X-Onden-Client-Now": String(Date.now()), ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body };
  }

  async send(client: string, write: PendingWrite, fate: Fate, who: Record<string, string> = {}): Promise<Reply | "lost"> {
    if (fate === "lose_request") return "lost";
    if (fate === "delay") { this.inFlight.push({ client, write: { ...write }, who }); return "lost"; }
    const reply = await this.call(write.method, write.path, write.body ?? undefined, { ...who, ...(write.idemKey ? { "Idempotency-Key": write.idemKey } : {}) });
    if (write.path !== "/api/sync" && write.path !== "/api/sync/nodes" && write.method !== "GET") {
      this.handled.push({ seq: this.handled.length, client, method: write.method, path: write.path, body: write.body, idemKey: write.idemKey, status: reply.status, replyLost: fate === "lose_response", reply: reply.body });
    }
    return fate === "lose_response" ? "lost" : reply;
  }

  /** The network delivers one delayed request now (`pick` counts from the oldest, wrapping); nobody reads its reply. */
  async deliverLate(pick: number): Promise<void> {
    if (!this.inFlight.length) return;
    const [late] = this.inFlight.splice(pick % this.inFlight.length, 1);
    await this.send(late!.client, late!.write, "lose_response", late!.who);
  }

  /** The network heals: everything still on the wire arrives, the newest first (the most reordered order). */
  async deliverAllLate(): Promise<void> {
    while (this.inFlight.length) await this.deliverLate(this.inFlight.length - 1);
  }
}
