import { describe, expect, it } from "vitest";
import {
  chunkCountFor, decryptChunk, decryptFile, describeItem, encryptChunk, encryptFileChunks, FileReceiver, FinalManifest, ManifestWriter,
  MIN_CHUNK_BYTES, openProgressManifest, PairingError, type ManifestItem,
} from "./index.ts";
import { pairedSession } from "./helpers.test-util.ts";

const CS = MIN_CHUNK_BYTES;
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof PairingError ? e.code : `other:${String(e)}`;
  }
  return "no_error";
};
// toEqual on multi-MiB typed arrays walks element by element and takes seconds; compare bytes directly.
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(a, b) === 0;
const itemFor = (size: number, id = "file1"): ManifestItem => describeItem({ id, kind: "file", name: "a.pdf", size, chunkSize: CS });

describe("chunk plan", () => {
  it.each([[0, 1], [1, 1], [CS - 1, 1], [CS, 1], [CS + 1, 2], [2 * CS, 2], [2 * CS + 5, 3]])("size %i → %i chunks", (size, count) => {
    expect(chunkCountFor(size, CS)).toBe(count);
  });
  it("rejects chunk sizes outside 1–4 MiB", () => {
    expect(code(() => chunkCountFor(10, CS - 1))).toBe("bad_chunk_size");
    expect(code(() => chunkCountFor(10, 4 * CS + 1))).toBe("bad_chunk_size");
    expect(chunkCountFor(10, 4 * CS)).toBe(1);
  });
});

describe("file round trip", () => {
  it.each([0, 1, CS - 1, CS, CS + 1, 2 * CS, 3 * CS + 17])("restores %i bytes exactly", (size) => {
    const { pageKeys, phoneKeys } = pairedSession();
    const data = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 5) & 255);
    const chunks = [...encryptFileChunks(pageKeys, "file1", data, CS)];
    expect(chunks).toHaveLength(chunkCountFor(size, CS));
    expect(sameBytes(decryptFile(phoneKeys, itemFor(size), chunks), data)).toBe(true);
  });

  it("round-trips random sizes at the 4 MiB chunk size", () => {
    const { pageKeys, phoneKeys } = pairedSession();
    const chunkSize = 4 * CS;
    for (const size of [0, 1, chunkSize, chunkSize + 1, 2 * chunkSize, 5_000_003]) {
      const data = new Uint8Array(size);
      for (let o = 0; o < size; o += 65536) crypto.getRandomValues(data.subarray(o, Math.min(size, o + 65536)));
      const item = describeItem({ id: "f", kind: "file", name: "x", size, chunkSize });
      expect(sameBytes(decryptFile(phoneKeys, item, [...encryptFileChunks(pageKeys, "f", data, chunkSize)]), data)).toBe(true);
    }
  });
});

describe("receiver refuses", () => {
  const setup = (size = 3 * CS) => {
    const s = pairedSession();
    const chunks = [...encryptFileChunks(s.pageKeys, "file1", bytes(size), CS)];
    return { ...s, chunks, item: itemFor(size) };
  };

  it("out-of-order chunks", () => {
    const { phoneKeys, chunks, item } = setup();
    const r = new FileReceiver(phoneKeys, item);
    expect(code(() => r.accept(1, chunks[1]!))).toBe("out_of_order");
    expect(r.nextIndex).toBe(0);
  });
  it("replayed chunks", () => {
    const { phoneKeys, chunks, item } = setup();
    const r = new FileReceiver(phoneKeys, item);
    r.accept(0, chunks[0]!);
    expect(code(() => r.accept(0, chunks[0]!))).toBe("replay");
  });
  it("a missing chunk (skipped, and absent in the all-at-once helper)", () => {
    const { phoneKeys, chunks, item } = setup();
    const r = new FileReceiver(phoneKeys, item);
    r.accept(0, chunks[0]!);
    expect(code(() => r.accept(2, chunks[2]!))).toBe("out_of_order");
    expect(code(() => decryptFile(phoneKeys, item, [chunks[0], undefined, chunks[2]]))).toBe("missing_chunk");
  });
  it("a file cut short (last chunk never arrives)", () => {
    const { phoneKeys, chunks, item } = setup();
    const r = new FileReceiver(phoneKeys, item);
    r.accept(0, chunks[0]!);
    r.accept(1, chunks[1]!);
    expect(code(() => r.finish())).toBe("truncated");
  });
  it("truncation that also relabels the last remaining chunk as final", () => {
    const { phoneKeys, pageKeys } = pairedSession();
    const [first] = [...encryptFileChunks(pageKeys, "file1", bytes(2 * CS), CS)];
    // The relay drops chunk 1 and presents chunk 0 as if it were the whole of a one-chunk file.
    const shortItem = describeItem({ id: "file1", kind: "file", name: "a", size: CS, chunkSize: CS });
    expect(code(() => decryptFile(phoneKeys, shortItem, [first]))).toBe("bad_chunk");
  });
  it("chunks of another session", () => {
    const { chunks, item } = setup();
    expect(code(() => decryptFile(pairedSession().phoneKeys, item, chunks))).toBe("bad_chunk");
  });
  it("chunks of another file in the same session", () => {
    const { phoneKeys, chunks } = setup();
    expect(code(() => decryptFile(phoneKeys, itemFor(3 * CS, "file2"), chunks))).toBe("bad_chunk");
  });
  it("altered ciphertext, altered tag, wrong final flag and wrong index", () => {
    const { phoneKeys, chunks, item } = setup();
    const tampered = chunks[0]!.slice();
    tampered[5]! ^= 1;
    expect(code(() => new FileReceiver(phoneKeys, item).accept(0, tampered))).toBe("bad_chunk");
    const badTag = chunks[0]!.slice();
    badTag[badTag.length - 1]! ^= 1;
    expect(code(() => new FileReceiver(phoneKeys, item).accept(0, badTag))).toBe("bad_chunk");
    expect(code(() => decryptChunk(phoneKeys, "file1", 0, true, chunks[0]!))).toBe("bad_chunk");
    expect(code(() => decryptChunk(phoneKeys, "file1", 1, false, chunks[0]!))).toBe("bad_chunk");
  });
  it("a chunk of the wrong length, before decrypting it", () => {
    const { pageKeys, phoneKeys, item } = setup();
    const short = encryptChunk(pageKeys, "file1", 0, false, bytes(CS - 1));
    expect(code(() => new FileReceiver(phoneKeys, item).accept(0, short))).toBe("bad_chunk_size");
  });
  it("an index beyond the promised chunk count", () => {
    const { phoneKeys, chunks, item } = setup();
    const r = new FileReceiver(phoneKeys, item);
    chunks.forEach((c, i) => r.accept(i, c));
    r.finish();
    expect(code(() => r.accept(3, chunks[0]!))).toBe("unknown_item");
  });
  it("a manifest entry whose chunk count does not match its size", () => {
    const { phoneKeys } = setup();
    expect(code(() => new FileReceiver(phoneKeys, { id: "file1", size: 3 * CS, chunks: 2, chunkSize: CS }))).toBe("bad_manifest");
  });
});

describe("manifests", () => {
  it("round-trips the progress and final lists", () => {
    const { pageKeys, phoneKeys } = pairedSession();
    const writer = new ManifestWriter(pageKeys);
    const items = [itemFor(10, "n1"), itemFor(5 * CS, "f2")];
    expect(openProgressManifest(phoneKeys, writer.progress(items.slice(0, 1)))).toEqual({ seq: 1, items: items.slice(0, 1) });
    expect(openProgressManifest(phoneKeys, writer.progress(items)).seq).toBe(2);
    expect(new FinalManifest(phoneKeys, writer.final(items)).items).toEqual(items);
  });

  it("refuses items that are not on the final list", () => {
    const { pageKeys, phoneKeys } = pairedSession();
    const final = new FinalManifest(phoneKeys, new ManifestWriter(pageKeys).final([itemFor(10, "listed")]));
    expect(code(() => final.receiverFor("smuggled"))).toBe("unknown_item");
    expect(final.receiverFor("listed")).toBeInstanceOf(FileReceiver);
  });

  it("does not accept a progress list as the final list, or the reverse", () => {
    const { pageKeys, phoneKeys } = pairedSession();
    const writer = new ManifestWriter(pageKeys);
    expect(code(() => new FinalManifest(phoneKeys, writer.progress([itemFor(1)])))).toBe("bad_manifest");
    expect(code(() => openProgressManifest(phoneKeys, writer.final([itemFor(1)])))).toBe("bad_manifest");
  });

  it("refuses a list from another session, a tampered list, and a second final list", () => {
    const { pageKeys, phoneKeys } = pairedSession();
    const blob = new ManifestWriter(pageKeys).final([itemFor(1)]);
    expect(code(() => new FinalManifest(pairedSession().phoneKeys, blob))).toBe("bad_manifest");
    const tampered = blob.slice();
    tampered[tampered.length - 3]! ^= 1;
    expect(code(() => new FinalManifest(phoneKeys, tampered))).toBe("bad_manifest");
    const writer = new ManifestWriter(pageKeys);
    writer.final([]);
    expect(code(() => writer.final([]))).toBe("bad_manifest");
    expect(code(() => writer.progress([]))).toBe("bad_manifest");
  });

  it("refuses duplicate ids and ids that are not safe object names when writing", () => {
    const { pageKeys } = pairedSession();
    const writer = new ManifestWriter(pageKeys);
    expect(code(() => writer.progress([itemFor(1, "a"), itemFor(1, "a")]))).toBe("bad_manifest");
    expect(code(() => writer.progress([itemFor(1, "../x")]))).toBe("bad_manifest");
  });
});
