import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";
import { fromBase64Url, lengthPrefixed, readU64be, u64be, utf8 } from "./encoding.ts";
import { PairingError } from "./errors.ts";
import type { SessionKeys } from "./pairing.ts";
import { assertChunkSize, chunkCountFor, FileReceiver } from "./stream.ts";

export type ManifestItemKind = "note" | "file";

export interface ManifestItem {
  /** Random id chosen by the page; also the name its chunks are stored under. [A-Za-z0-9_-], 1–64 chars. */
  id: string;
  kind: ManifestItemKind;
  /** Display name (note title or file name). */
  name: string;
  /** Plaintext size in bytes. */
  size: number;
  /** Number of chunks; always `chunkCountFor(size, chunkSize)`. */
  chunks: number;
  chunkSize: number;
}

export const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ITEMS = 10_000;
const MAX_NAME_LENGTH = 255;
const BLOB_VERSION = 1;

type ManifestKind = "progress" | "final";

function manifestKey(keys: SessionKeys, kind: ManifestKind): Uint8Array {
  return keys.derive(kind === "final" ? "final-manifest-key" : "manifest-key");
}

function manifestAad(keys: SessionKeys, kind: ManifestKind, seq: number): Uint8Array {
  return lengthPrefixed(utf8("onden-stp/v1/manifest"), fromBase64Url(keys.sessionId), utf8(kind), u64be(seq));
}

const NONCE_BYTES = 12;

/** Build a validated item for a file of `size` bytes. */
export function describeItem(input: { id: string; kind: ManifestItemKind; name: string; size: number; chunkSize: number }): ManifestItem {
  return { ...input, chunks: chunkCountFor(input.size, input.chunkSize) };
}

function validateItems(value: unknown): ManifestItem[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new PairingError("bad_manifest");
  const seen = new Set<string>();
  return value.map((raw): ManifestItem => {
    if (typeof raw !== "object" || raw === null) throw new PairingError("bad_manifest");
    const { id, kind, name, size, chunks, chunkSize } = raw as Record<string, unknown>;
    if (typeof id !== "string" || !ITEM_ID_PATTERN.test(id) || seen.has(id)) throw new PairingError("bad_manifest");
    if (kind !== "note" && kind !== "file") throw new PairingError("bad_manifest");
    if (typeof name !== "string" || name.length > MAX_NAME_LENGTH) throw new PairingError("bad_manifest");
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new PairingError("bad_manifest");
    if (typeof chunkSize !== "number") throw new PairingError("bad_manifest");
    try {
      assertChunkSize(chunkSize);
    } catch {
      throw new PairingError("bad_manifest");
    }
    if (chunks !== chunkCountFor(size, chunkSize)) throw new PairingError("bad_manifest");
    seen.add(id);
    return { id, kind, name, size, chunks, chunkSize };
  });
}

function seal(keys: SessionKeys, kind: ManifestKind, seq: number, items: readonly ManifestItem[]): Uint8Array {
  validateItems(items);
  // Random nonce: a reloaded page restarts its sequence numbers, and the key does not change, so a counter nonce could repeat.
  const nonce = randomBytes(NONCE_BYTES);
  const ct = chacha20poly1305(manifestKey(keys, kind), nonce, manifestAad(keys, kind, seq)).encrypt(utf8(JSON.stringify({ items })));
  return concatBytes(Uint8Array.of(BLOB_VERSION), u64be(seq), nonce, ct);
}

function open(keys: SessionKeys, kind: ManifestKind, blob: Uint8Array): { seq: number; items: ManifestItem[] } {
  if (blob.length < 9 + NONCE_BYTES + 16 || blob[0] !== BLOB_VERSION) throw new PairingError("bad_manifest");
  const seq = readU64be(blob, 1);
  let plain: Uint8Array;
  try {
    plain = chacha20poly1305(manifestKey(keys, kind), blob.subarray(9, 9 + NONCE_BYTES), manifestAad(keys, kind, seq)).decrypt(blob.subarray(9 + NONCE_BYTES));
  } catch {
    throw new PairingError("bad_manifest");
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain));
    return { seq, items: validateItems((parsed as { items?: unknown }).items) };
  } catch (error) {
    throw error instanceof PairingError ? error : new PairingError("bad_manifest");
  }
}

/**
 * Page side: writes the running list (advisory, for progress) and finally the final list.
 * Sequence numbers are issued here, one per call, so a (key, nonce) pair is never used twice.
 */
export class ManifestWriter {
  readonly #keys: SessionKeys;
  #seq = 0;
  #finalWritten = false;

  constructor(keys: SessionKeys) {
    this.#keys = keys;
  }

  progress(items: readonly ManifestItem[]): Uint8Array {
    if (this.#finalWritten) throw new PairingError("bad_manifest");
    this.#seq += 1;
    return seal(this.#keys, "progress", this.#seq, items);
  }

  /** The list of everything the phone may import. Can be produced once. */
  final(items: readonly ManifestItem[]): Uint8Array {
    if (this.#finalWritten) throw new PairingError("bad_manifest");
    this.#finalWritten = true;
    return seal(this.#keys, "final", 0, items);
  }
}

/** Phone side: read the running list (only for showing progress; never import from it). */
export function openProgressManifest(keys: SessionKeys, blob: Uint8Array): { seq: number; items: ManifestItem[] } {
  return open(keys, "progress", blob);
}

/** The authenticated final list. The only source of what to import. */
export class FinalManifest {
  readonly items: readonly ManifestItem[];
  readonly #keys: SessionKeys;

  constructor(keys: SessionKeys, blob: Uint8Array) {
    this.#keys = keys;
    this.items = open(keys, "final", blob).items;
  }

  /** A receiver for one listed item; items not on the list are refused with `unknown_item`. */
  receiverFor(itemId: string): FileReceiver {
    const item = this.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new PairingError("unknown_item");
    return new FileReceiver(this.#keys, item);
  }
}
