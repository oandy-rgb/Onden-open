// The embedding model behind semantic search — a swappable interface so the
// pipeline (storage, outbox job, query, agent tool) is built and tested without
// committing to one model. DEFAULT is the real LOCAL model (multilingual-e5-
// small, 384-d, Transformers.js): semantic search works locally + privately
// out of the box — no data leaves the box (the sovereignty thesis must be true
// by DEFAULT, not opt-in; see [[product-thesis]] / architecture-comparison 08).
// A deterministic STUB (no model download, fully offline, CI-safe) stays behind
// EMBEDDING_MODE=stub and is the default under test (NODE_ENV=test) so the suite
// and CI never pull a native ONNX runtime. Explicit override: EMBEDDING_MODE
// = "local" | "stub".
import { config, isTest } from "../config.js";

const EMBED_DIM = 384;

// Asymmetric retrieval: e5-family models want a "query:" / "passage:" prefix so
// a short query and a long document land near each other. role tells the
// embedder which side it's encoding (the stub ignores it).
export type EmbedRole = "query" | "passage";

export interface Embedder {
  /** Stable identifier stored on each row so a model swap is detectable. */
  readonly name: string;
  /** Returns an L2-normalised EMBED_DIM vector. */
  embed(text: string, role?: EmbedRole): Promise<number[]>;
}

// Deterministic pseudo-embedding: same text → same vector, different text →
// different vector, L2-normalised. NOT semantic — it exists so the pipeline is
// fully testable offline (an exact body match has cosine distance 0, so it
// ranks first), and so dev works before a real model is configured.
function stubVector(text: string): number[] {
  let h = 2166136261 >>> 0; // FNV-1a seed
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const v = new Array<number>(EMBED_DIM);
  let seed = h || 1;
  for (let i = 0; i < EMBED_DIM; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; // LCG
    v[i] = (seed / 4294967296) * 2 - 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const stubEmbedder: Embedder = {
  name: "stub-v1",
  async embed(text: string) {
    return stubVector(text);
  },
};

// Real local embedder: Transformers.js running multilingual-e5-small (384-d,
// covers Chinese + English — verified cross-lingual). No data leaves the box.
//
// This is the DEFAULT outside tests. The package is an OPT-IN manual install
// (not a declared dependency) so the base install + CI stay lean and don't pull
// a native ONNX runtime for everyone:
//     npm install @huggingface/transformers      # heavy: pulls onnxruntime
// If the package is absent at runtime the dynamic import below throws a clear
// "run `npm install @huggingface/transformers`" error rather than silently
// falling back to a non-semantic stub. Force the stub with EMBEDDING_MODE=stub.
//
// The package is loaded via a DYNAMIC import with a widened specifier so the
// build/tsc/CI do NOT require it to be present — it's only touched at runtime
// when EMBEDDING_MODE=local. The model weights cache on first use.
const LOCAL_MODEL = "Xenova/multilingual-e5-small";
const TRANSFORMERS_PKG: string = "@huggingface/transformers"; // widened → not statically resolved

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractorPromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getExtractor(): Promise<any> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      // (rejection resets the memo below — see the .catch after creation)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let mod: any;
      try {
        mod = await import(TRANSFORMERS_PKG);
      } catch {
        throw new Error(
          "Local embeddings need the @huggingface/transformers package — run " +
            "`npm install @huggingface/transformers`, or set EMBEDDING_MODE=stub " +
            "to use the non-semantic offline stub.",
        );
      }
      return mod.pipeline("feature-extraction", LOCAL_MODEL);
    })();
    // A REJECTED memo must not poison the process: the first model download
    // can fail transiently (network blip; 200 concurrent first-embeds racing
    // the same download), and caching that rejection turned every later embed
    // into the same error until restart — the outbox retried forever against
    // a dead promise. Reset so the next call re-attempts the load.
    extractorPromise.catch(() => { extractorPromise = null; });
  }
  return extractorPromise;
}

const localEmbedder: Embedder = {
  name: "multilingual-e5-small",
  async embed(text: string, role: EmbedRole = "passage") {
    const extractor = await getExtractor();
    // e5 prefix convention — asymmetric query/passage encoding.
    const input = `${role}: ${text}`;
    const out = await extractor(input, { pooling: "mean", normalize: true });
    return Array.from(out.data as Float32Array);
  },
};

let cached: Embedder | null = null;

/** The active embedder, chosen by EMBEDDING_MODE.
 *  Default: 'local' (private, semantic, no egress) — EXCEPT under test
 *  (NODE_ENV=test) where it defaults to 'stub' so the suite/CI stay offline
 *  and never download model weights. EMBEDDING_MODE always wins when set. */
export function getEmbedder(): Embedder {
  if (cached) return cached;
  const mode = config.str("EMBEDDING_MODE") ?? (isTest() ? "stub" : "local");
  cached = mode === "stub" ? stubEmbedder : localEmbedder;
  return cached;
}

// Test seam: override the active embedder.
export function __setEmbedderForTest(e: Embedder | null): void {
  cached = e;
}

/** pgvector text format for a parameter: `[a,b,c]` (JSON happens to match). */
export function toVectorLiteral(vec: number[]): string {
  return JSON.stringify(vec);
}
