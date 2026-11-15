// SSRF-hardened outbound fetch (security audit 2026-06-12 #2). Every place
// the server fetches a USER-SUPPLIED url (bookmark previews, ask's web
// source, RSS feeds) goes through here instead of global fetch:
//
//   • http/https only — no file:, gopher:, ftp:, data:
//   • the connect-time `lookup` hook validates the RESOLVED address and
//     refuses loopback / private / link-local / CGNAT / metadata ranges —
//     validating at connect (not before) closes the DNS-rebinding window,
//     because the socket can only ever dial an address that just passed
//   • redirects are followed manually (default 3 hops) and every hop goes
//     through the same validation
//   • hard timeout + response size cap (the body is read incrementally and
//     the socket destroyed the moment it exceeds the cap)
//
// Built on node:http(s) directly: global fetch (undici) doesn't expose a
// lookup hook without adding the undici package.

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { config, isProduction } from "../config.js";

/** True when the ip must never be dialled from a server-side fetch. */
export function isForbiddenAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isForbiddenV4(ip);
  if (v === 6) return isForbiddenV6(ip);
  return true; // not an IP at all — refuse
}

/** Expand an IPv6 literal to its 8 16-bit groups (numbers), or null if it
 *  can't be parsed. Handles `::` compression and an embedded IPv4 tail. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]; // drop any zone id
  // Fold a dotted-decimal IPv4 tail (::ffff:127.0.0.1) into two hex groups so a
  // single parser covers every textual form of an embedded v4.
  const dot = s.lastIndexOf(".");
  if (dot !== -1) {
    const colon = s.lastIndexOf(":");
    const v4 = s.slice(colon + 1).split(".").map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = s.slice(0, colon + 1) + hi + ":" + lo;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (head.length + tail.length > 7) {
    return null; // `::` must stand in for at least one zero group
  }
  const mid = halves.length === 2 ? new Array(8 - head.length - tail.length).fill("0") : [];
  const groups = [...head, ...mid, ...tail].map((h) => parseInt(h || "0", 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/** True when an IPv6 address (in ANY textual form) must never be dialled. Parses
 *  to the canonical 128-bit value and tests ranges by prefix — string-matching
 *  the v4-mapped dotted form alone let the hex form (::ffff:7f00:1 = 127.0.0.1)
 *  and the cloud-metadata mapping (::ffff:a9fe:a9fe) sail straight through. */
function isForbiddenV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true; // unparseable → refuse
  const embeddedV4 = (a: number, b: number): string =>
    `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
  const top96Zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  // v4-mapped ::ffff:0:0/96 AND v4-compatible/loopback/unspecified ::/96 — the
  // last 32 bits are an embedded IPv4 (covers ::1 → 0.0.0.1, :: → 0.0.0.0).
  if (top96Zero && (g[5] === 0xffff || g[5] === 0)) return isForbiddenV4(embeddedV4(g[6], g[7]));
  // NAT64 well-known prefix 64:ff9b::/96 — embedded IPv4 in the low 32 bits.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0)
    return isForbiddenV4(embeddedV4(g[6], g[7]));
  // 6to4 2002::/16 — the embedded IPv4 is the next 32 bits.
  if (g[0] === 0x2002) return isForbiddenV4(embeddedV4(g[1], g[2]));
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

function isForbiddenV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 10) return true;              // this-net / loopback / private
  if (a === 169 && b === 254) return true;                        // link-local + cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;               // private
  if (a === 192 && b === 168) return true;                        // private
  if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT
  if (a === 192 && parts[2] === 0 && parts[3] >= 0 && b === 0) return true; // 192.0.0.0/24 special
  if (a >= 224) return true;                                      // multicast + reserved + broadcast
  return false;
}

export class SafeFetchError extends Error {
  constructor(message: string, public readonly code:
    "forbidden_address" | "bad_protocol" | "too_many_redirects" | "too_large" | "timeout" | "network") {
    super(message);
  }
}

export type SafeFetchOptions = {
  headers?: Record<string, string>;
  /** Idle timeout of the socket: no byte for this long. */
  timeoutMs?: number;
  /** Total deadline for the whole call, redirects and body included. A peer
   *  that trickles a byte just inside every idle window never trips
   *  `timeoutMs`; this is what ends it. Default: 3 × timeoutMs. */
  deadlineMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** TESTS ONLY: lets the suite exercise redirect/size mechanics against a
   *  local server without weakening the production default. */
  allowPrivateAddresses?: boolean;
};

export type SafeResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
};

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  // TEST ENVIRONMENTS ONLY: integration suites serve fixtures from 127.0.0.1,
  // and the full-stack e2e stack fetches feeds from the internal `nginx`/
  // `backend` Docker hosts. The opt-in flag governs, but PRODUCTION never
  // weakens (NODE_ENV=production hard-blocks regardless of the flag) — the same
  // footgun-closing posture as nativeBypassEnabled. The e2e stack can't run as
  // NODE_ENV=test (that skips migrate()), so the gate keys on "not production",
  // not "is test".
  if (opts.allowPrivateAddresses === undefined
      && !isProduction() && config.is("SAFE_FETCH_ALLOW_PRIVATE", "1")) {
    opts = { ...opts, allowPrivateAddresses: true };
  }
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const deadline = AbortSignal.timeout(opts.deadlineMs ?? timeoutMs * 3);

  let url = new URL(rawUrl);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SafeFetchError(`refusing protocol ${url.protocol}`, "bad_protocol");
    }
    // IP literals skip DNS — validate them directly, same rule.
    if (!opts.allowPrivateAddresses && isIP(url.hostname.replace(/^\[|\]$/g, "")) && isForbiddenAddress(url.hostname.replace(/^\[|\]$/g, ""))) {
      throw new SafeFetchError(`refusing address ${url.hostname}`, "forbidden_address");
    }
    const res = await requestOnce(url, opts, timeoutMs, maxBytes, deadline);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      if (hop >= maxRedirects) throw new SafeFetchError("too many redirects", "too_many_redirects");
      url = new URL(String(res.headers.location), url); // relative-safe
      continue;
    }
    return res;
  }
}

function requestOnce(url: URL, opts: SafeFetchOptions, timeoutMs: number, maxBytes: number, deadline: AbortSignal): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const doRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = doRequest(
      url,
      {
        method: "GET",
        headers: opts.headers,
        timeout: timeoutMs,
        signal: deadline,
        // The SSRF gate: validate what DNS actually resolved, at connect time.
        // Force `all: true` and check EVERY record — under Happy-Eyeballs /
        // autoSelectFamily the socket may dial any resolved address, so a single
        // forbidden record (e.g. a rebinding name returning one public + one
        // loopback A) must reject the whole connect, not just address[0].
        lookup: (hostname, options, cb) => {
          const o = ((options && typeof options === "object") ? options : {}) as { family?: number; all?: boolean };
          const anyCb = cb as (e: NodeJS.ErrnoException | null, a?: unknown, f?: number) => void;
          dnsLookup(hostname, { ...o, all: true }, (err, addresses) => {
            if (err) { anyCb(err); return; }
            const list = Array.isArray(addresses)
              ? addresses
              : [{ address: String(addresses), family: Number(o.family) || 0 }];
            if (!opts.allowPrivateAddresses) {
              const bad = list.find((a) => isForbiddenAddress(a.address));
              if (bad) {
                anyCb(new SafeFetchError(`refusing resolved address ${bad.address} for ${hostname}`, "forbidden_address"), "", 4);
                return;
              }
            }
            // Return in the shape the caller asked for (array when it requested
            // all, else the first record) so net.connect's family handling is intact.
            if (o.all) { anyCb(null, list as unknown); return; }
            anyCb(null, list[0].address, list[0].family);
          });
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            req.destroy();
            reject(new SafeFetchError(`response exceeded ${maxBytes} bytes`, "too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", (e) => reject(deadline.aborted ? new SafeFetchError("timeout", "timeout") : new SafeFetchError(e.message, "network")));
      },
    );
    req.on("timeout", () => { req.destroy(new SafeFetchError("timeout", "timeout")); });
    req.on("error", (e) => reject(
      e instanceof SafeFetchError ? e
        : deadline.aborted ? new SafeFetchError("timeout", "timeout")
        : new SafeFetchError((e as Error).message, "network"),
    ));
    req.end();
  });
}
