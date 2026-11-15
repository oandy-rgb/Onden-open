import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { fromBase64Url, lengthPrefixed, u64be, utf8 } from "./encoding.ts";
import { PairingError } from "./errors.ts";
import type { SessionKeys } from "./pairing.ts";

export const TAG_BYTES = 16;
export const MIN_CHUNK_BYTES = 1024 * 1024;
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const DEFAULT_CHUNK_BYTES = MIN_CHUNK_BYTES;

export function assertChunkSize(chunkSize: number): void {
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_BYTES || chunkSize > MAX_CHUNK_BYTES) throw new PairingError("bad_chunk_size");
}

/** An empty file is one empty final chunk; otherwise ceil(size / chunkSize). */
export function chunkCountFor(size: number, chunkSize: number): number {
  assertChunkSize(chunkSize);
  return Math.max(1, Math.ceil(size / chunkSize));
}

const fileKey = (keys: SessionKeys, fileId: string): Uint8Array => keys.derive("file-key", 32, utf8(fileId));

/** 12-byte ChaCha20-Poly1305 nonce: four zero bytes then the chunk index. The key is per file, so (key, nonce) never repeats. */
function chunkNonce(index: number): Uint8Array {
  return concatBytes(new Uint8Array(4), u64be(index));
}

function chunkAad(keys: SessionKeys, fileId: string, index: number, isFinal: boolean): Uint8Array {
  return lengthPrefixed(utf8("onden-stp/v1/chunk"), fromBase64Url(keys.sessionId), utf8(fileId), u64be(index), Uint8Array.of(isFinal ? 1 : 0));
}

/** Encrypt one chunk. Callers choose `isFinal` (it is authenticated, so the receiver detects truncation). */
export function encryptChunk(keys: SessionKeys, fileId: string, index: number, isFinal: boolean, plaintext: Uint8Array): Uint8Array {
  return chacha20poly1305(fileKey(keys, fileId), chunkNonce(index), chunkAad(keys, fileId, index, isFinal)).encrypt(plaintext);
}

/** Stateless decrypt of one chunk at a claimed position. Throws `bad_chunk` for any mismatch. */
export function decryptChunk(keys: SessionKeys, fileId: string, index: number, isFinal: boolean, ciphertext: Uint8Array): Uint8Array {
  try {
    return chacha20poly1305(fileKey(keys, fileId), chunkNonce(index), chunkAad(keys, fileId, index, isFinal)).decrypt(ciphertext);
  } catch {
    throw new PairingError("bad_chunk");
  }
}

/** Split and encrypt a whole file. Yields chunks in index order. */
export function* encryptFileChunks(keys: SessionKeys, fileId: string, bytes: Uint8Array, chunkSize = DEFAULT_CHUNK_BYTES): Generator<Uint8Array> {
  const count = chunkCountFor(bytes.length, chunkSize);
  for (let index = 0; index < count; index++) {
    yield encryptChunk(keys, fileId, index, index === count - 1, bytes.subarray(index * chunkSize, (index + 1) * chunkSize));
  }
}

/**
 * Receiver for one file: accepts chunks strictly in order, knowing the chunk count and size the final
 * manifest promised. Any other order, repeat, wrong-size chunk or early end is refused.
 */
export class FileReceiver {
  readonly #keys: SessionKeys;
  readonly #fileId: string;
  readonly #chunkSize: number;
  readonly #count: number;
  readonly #expectedSize: number;
  #next = 0;
  #received = 0;

  constructor(keys: SessionKeys, item: { id: string; size: number; chunks: number; chunkSize: number }) {
    assertChunkSize(item.chunkSize);
    if (item.chunks !== chunkCountFor(item.size, item.chunkSize)) throw new PairingError("bad_manifest");
    this.#keys = keys;
    this.#fileId = item.id;
    this.#chunkSize = item.chunkSize;
    this.#count = item.chunks;
    this.#expectedSize = item.size;
  }

  get nextIndex(): number {
    return this.#next;
  }

  /** Decrypt the chunk at `index`; it must be exactly the next one. */
  accept(index: number, ciphertext: Uint8Array): Uint8Array {
    if (index < this.#next) throw new PairingError("replay");
    if (index > this.#next) throw new PairingError("out_of_order");
    if (index >= this.#count) throw new PairingError("unknown_item");
    const isFinal = index === this.#count - 1;
    const plainLength = ciphertext.length - TAG_BYTES;
    // Every chunk but the last is full; the last holds whatever remains. Checked before decrypting.
    const expected = isFinal ? this.#expectedSize - index * this.#chunkSize : this.#chunkSize;
    if (plainLength !== expected) throw new PairingError("bad_chunk_size");
    const plaintext = decryptChunk(this.#keys, this.#fileId, index, isFinal, ciphertext);
    this.#next += 1;
    this.#received += plaintext.length;
    return plaintext;
  }

  /** Call after the last chunk: throws `truncated` unless every promised chunk arrived. */
  finish(): void {
    if (this.#next !== this.#count || this.#received !== this.#expectedSize) throw new PairingError(this.#next < this.#count ? "truncated" : "bad_size");
  }
}

/** Convenience for small files held in memory: decrypt all chunks (in index order) into one array. */
export function decryptFile(keys: SessionKeys, item: { id: string; size: number; chunks: number; chunkSize: number }, chunks: readonly (Uint8Array | undefined)[]): Uint8Array {
  const receiver = new FileReceiver(keys, item);
  const parts: Uint8Array[] = [];
  for (let index = 0; index < item.chunks; index++) {
    const chunk = chunks[index];
    if (!chunk) throw new PairingError("missing_chunk");
    parts.push(receiver.accept(index, chunk));
  }
  if (chunks.length > item.chunks) throw new PairingError("unknown_item");
  receiver.finish();
  return concatBytes(...parts);
}

