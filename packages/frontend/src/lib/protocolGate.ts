// Whether this page may send writes and sync requests, judged by the sync protocol (CLIENT_PROTOCOL in
// @onden/markdown). Two ways to be stopped, one effect: the same rule the server applies to a too-old client, turned
// around. While stopped, no write and no sync request (isSyncPath: bootstrap, delta, bodies, drawings, membership,
// whatever the method) leaves the page, because a copy built from a shape this page misreads is worse than the copy it
// has; the page shows its own copy. Nothing is dropped (the write queue keeps what it has and lib/data/writeErrors
// treats it as "wait for an update", not a rejection), and nothing retries against the network. Other reads go out.
// The two sides sync only when their protocols are equal (CLIENT_PROTOCOL): there is no range that still works.
//  - "page_old":   the server speaks a newer protocol, or refused this page as too old (426 client_too_old). The page
//                  is the one to update: a reload ends it.
//  - "server_old": the server says (X-Onden-Server-Protocol) it speaks an older protocol, as with a browser or desktop
//                  build talking to a server that was not updated. Held requests never
//                  reach the network, so the gate asks the server itself (setProtocolProbe: a plain read) every so
//                  often; the first answer from an updated server ends the stop, with no reload.
// Imports only the contract: lib/api.ts calls this on every response, and the write queue listens.
import { useSyncExternalStore } from "react";
import { protocolMismatch } from "@onden/markdown";

export type ProtocolBlock = "page_old" | "server_old";

/** A server that sends no protocol header predates the header, which began at protocol 3. */
const PROTOCOL_BEFORE_HEADER = 3;

/** How long to wait before asking the server again whether it was updated; the last wait repeats. */
export const PROTOCOL_PROBE_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000];

let block: ProtocolBlock | null = null;
const listeners = new Set<(block: ProtocolBlock | null) => void>();
let probe: (() => Promise<unknown>) | null = null;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probeStep = 0;

/** A request the page may always send (a plain read outside sync): its answer carries the server's protocol. Set once
 *  by lib/api.ts, which owns requests. */
export function setProtocolProbe(request: (() => Promise<unknown>) | null): void { probe = request; }

function stopProbing(): void {
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
  probeStep = 0;
}

function scheduleProbe(): void {
  if (!probe || probeTimer || block !== "server_old") return;
  const delay = PROBE_DELAYS_AT(probeStep++);
  probeTimer = setTimeout(() => {
    probeTimer = null;
    // The answer goes through noteServerProtocol like any other; a failed probe just waits for the next one.
    void Promise.resolve(probe?.()).catch(() => {}).finally(scheduleProbe);
  }, delay);
}
const PROBE_DELAYS_AT = (step: number) => PROTOCOL_PROBE_DELAYS_MS[Math.min(step, PROTOCOL_PROBE_DELAYS_MS.length - 1)]!;

export function currentProtocolBlock(): ProtocolBlock | null { return block; }

function setBlock(next: ProtocolBlock | null): void {
  if (block === next) return;
  block = next;
  stopProbing();
  scheduleProbe();
  for (const listener of [...listeners]) listener(block);
}

/** Hears every change of the block (the app's notice, the queue's flush once an updated server answers). */
export function onProtocolBlockChange(listener: (block: ProtocolBlock | null) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The block now in force, for a component (the 「伺服器需要更新」 notice). */
export function useProtocolBlock(): ProtocolBlock | null {
  return useSyncExternalStore(onProtocolBlockChange, currentProtocolBlock, currentProtocolBlock);
}

/** The server refused this page as too old. */
export function noteRefusedAsTooOld(): void { setBlock("page_old"); }

/** A response from the backend (any status below 500 and a 426: a gateway's own error page says nothing about the
 *  server). `header` is its X-Onden-Server-Protocol, null when absent. */
export function noteServerProtocol(header: string | null): void {
  if (block === "page_old") return;
  const mismatch = protocolMismatch(header ?? String(PROTOCOL_BEFORE_HEADER));
  setBlock(mismatch === "older" ? "server_old" : mismatch === "newer" ? "page_old" : null);
}

/** For tests: lifts the stop without telling listeners (the queue's own stays registered). */
export function resetProtocolGate(): void { block = null; stopProbing(); }
