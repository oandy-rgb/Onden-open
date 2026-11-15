import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { fromBase64Url, lengthPrefixed, toBase64Url, utf8 } from "./encoding.ts";
import { PairingError } from "./errors.ts";

export const PROTOCOL_VERSION = 1;
const SESSION_ID_BYTES = 16;
const KEY_BYTES = 32;
const INVITE_PREFIX = "stp1:";

/** Random source; tests pass a fixed one. Production always uses the platform's secure random. */
export type RandomSource = (length: number) => Uint8Array;

export interface InviteContents {
  /** Base URL of the relay (碰面點). */
  relayUrl: string;
  sessionId: string;
  /** The page's ephemeral X25519 public key, base64url. Public data, no secret. */
  pagePublicKey: string;
}

/** What the page keeps between showing the QR and receiving the phone's answer. Never leaves the page. */
export interface PagePairing {
  invite: InviteContents;
  secretKey: Uint8Array;
}

/** What the phone keeps between scanning and receiving the page's confirmation. */
export interface PhonePairing {
  sessionId: string;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  pagePublicKey: Uint8Array;
}

/** Page side, step 1. */
export function createInvite(relayUrl: string, random: RandomSource = randomBytes): PagePairing {
  const secretKey = random(KEY_BYTES);
  return {
    secretKey,
    invite: {
      relayUrl,
      sessionId: toBase64Url(random(SESSION_ID_BYTES)),
      pagePublicKey: toBase64Url(x25519.getPublicKey(secretKey)),
    },
  };
}

/** The text a QR code carries. */
export function encodeInvite(invite: InviteContents): string {
  return INVITE_PREFIX + toBase64Url(utf8(JSON.stringify({ v: PROTOCOL_VERSION, r: invite.relayUrl, s: invite.sessionId, k: invite.pagePublicKey })));
}

export function parseInvite(text: string): InviteContents {
  if (!text.startsWith(INVITE_PREFIX)) throw new PairingError("bad_invite");
  try {
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromBase64Url(text.slice(INVITE_PREFIX.length)));
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error();
    const { v, r, s, k } = parsed as Record<string, unknown>;
    if (v !== PROTOCOL_VERSION || typeof r !== "string" || typeof s !== "string" || typeof k !== "string") throw new Error();
    if (fromBase64Url(s).length !== SESSION_ID_BYTES || fromBase64Url(k).length !== KEY_BYTES) throw new Error();
    if (!/^https?:\/\//.test(r)) throw new Error();
    return { relayUrl: r, sessionId: s, pagePublicKey: k };
  } catch {
    throw new PairingError("bad_invite");
  }
}

/** Phone side: accept a scanned invite. `hello` is what gets put on the relay for the page to fetch. */
export function acceptInvite(invite: InviteContents, random: RandomSource = randomBytes): { phone: PhonePairing; hello: Uint8Array } {
  const secretKey = random(KEY_BYTES);
  const publicKey = x25519.getPublicKey(secretKey);
  const hello = new Uint8Array(1 + KEY_BYTES);
  hello[0] = PROTOCOL_VERSION;
  hello.set(publicKey, 1);
  return { hello, phone: { sessionId: invite.sessionId, secretKey, publicKey, pagePublicKey: fromBase64Url(invite.pagePublicKey) } };
}

export function parseHello(hello: Uint8Array): Uint8Array {
  if (hello.length !== 1 + KEY_BYTES || hello[0] !== PROTOCOL_VERSION) throw new PairingError("bad_hello");
  return hello.slice(1);
}

const LABEL = "onden-stp/v1/";

/**
 * Everything both sides can derive once the X25519 exchange is done. Holds the master key privately;
 * callers get purpose-bound values only. See docs/architecture/send-to-phone-crypto.md for the derivation table.
 */
export class SessionKeys {
  readonly sessionId: string;
  readonly #master: Uint8Array;

  constructor(sessionId: string, master: Uint8Array) {
    this.sessionId = sessionId;
    this.#master = master;
  }

  /** HKDF-Expand from the master key with a purpose label; different labels give independent keys. */
  derive(purpose: string, length = KEY_BYTES, context: Uint8Array = new Uint8Array(0)): Uint8Array {
    return hkdf(sha256, this.#master, undefined, lengthPrefixed(utf8(LABEL + purpose), context), length);
  }

  /** The 6 digits both screens show. Differs on the two sides if the public keys were swapped in transit. */
  confirmationCode(): string {
    const bytes = this.derive("confirm", 4);
    const n = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
    return String(n % 1_000_000).padStart(6, "0");
  }

  /** The page presents this to write to the relay. */
  writeToken(): string {
    return toBase64Url(this.derive("write-token"));
  }

  /** The phone presents this to list, fetch and delete. */
  readToken(): string {
    return toBase64Url(this.derive("read-token"));
  }
}

/** What the relay stores in place of a token: lowercase hex SHA-256 of the token's UTF-8 text. */
export function tokenHash(token: string): string {
  return [...sha256(utf8(token))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function deriveSession(sessionId: string, secretKey: Uint8Array, otherPublicKey: Uint8Array, pagePublicKey: Uint8Array, phonePublicKey: Uint8Array): SessionKeys {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(secretKey, otherPublicKey);
  } catch {
    throw new PairingError("bad_key"); // wrong length or a low-order point
  }
  const master = hkdf(
    sha256,
    shared,
    fromBase64Url(sessionId),
    lengthPrefixed(utf8(LABEL + "master"), pagePublicKey, phonePublicKey),
    KEY_BYTES,
  );
  return new SessionKeys(sessionId, master);
}

/** Page side, step 2: the phone's hello arrived. */
export function completeOnPage(page: PagePairing, hello: Uint8Array): SessionKeys {
  const phonePublicKey = parseHello(hello);
  return deriveSession(page.invite.sessionId, page.secretKey, phonePublicKey, fromBase64Url(page.invite.pagePublicKey), phonePublicKey);
}

/** Phone side, step 2: it already holds the page's key from the invite. */
export function completeOnPhone(phone: PhonePairing): SessionKeys {
  return deriveSession(phone.sessionId, phone.secretKey, phone.pagePublicKey, phone.pagePublicKey, phone.publicKey);
}
