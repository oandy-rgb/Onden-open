// Pure parts of the random sync e2e (randomSync.spec.ts): the seeded generator,
// the operation vocabulary and the plain-language log. No Playwright here, so
// it can be run and unit-checked in plain Node.

export type Slot = "A1" | "A2" | "B";
export const SLOTS: Slot[] = ["A1", "A2", "B"];

export type OpKind =
  | "type" // type a unique token line into a note
  | "deleteToken" // delete one token line this tab typed earlier
  | "rename" // change a note's title
  | "create" // new note via quick capture
  | "delete" // delete a note (action menu)
  | "undoDelete" // press Undo on the delete toast
  | "offline" // this tab only
  | "online"
  | "reload"
  | "closeReopen";

/** `r` is a free random number; the executor resolves it against the state it
 *  finds (which note, which token), so replaying the same list re-picks the
 *  same things as long as the app behaves the same. */
export type Op = { kind: OpKind; slot: Slot; r: number };

/** mulberry32: small, seedable, good enough for picking operations. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEIGHTS: Array<[OpKind, number]> = [
  ["type", 6], ["deleteToken", 2], ["rename", 2], ["create", 2], ["delete", 1],
  ["offline", 2], ["online", 2], ["reload", 1], ["closeReopen", 1],
];

export function generateOps(seed: number, count: number): Op[] {
  const next = rng(seed);
  const total = WEIGHTS.reduce((n, [, w]) => n + w, 0);
  const ops: Op[] = [];
  const pick = (): OpKind => {
    let at = next() * total;
    for (const [kind, w] of WEIGHTS) if ((at -= w) < 0) return kind;
    return "type";
  };
  while (ops.length < count) {
    const kind = pick();
    const slot = SLOTS[Math.floor(next() * SLOTS.length)]!;
    ops.push({ kind, slot, r: Math.floor(next() * 1_000_000) });
    // Undo is only offered while the toast is up, so it follows its delete.
    if (kind === "delete" && next() < 0.5 && ops.length < count) ops.push({ kind: "undoDelete", slot, r: 0 });
  }
  return ops;
}

export const SLOT_LABEL: Record<Slot, string> = {
  A1: "裝置 A 的分頁 1",
  A2: "裝置 A 的分頁 2",
  B: "裝置 B",
};

/** A sentence a person can read: `detail` is what the executor actually did. */
export function describeRandomSyncStep(op: Op, detail: string): string {
  return `${SLOT_LABEL[op.slot]}：${detail}`;
}

export function parseReplay(raw: string): Op[] {
  const parsed: unknown = JSON.parse(raw);
  const kinds = new Set<string>(WEIGHTS.map(([k]) => k).concat("undoDelete"));
  if (!Array.isArray(parsed)) throw new Error("E2E_RANDOM_REPLAY 必須是操作的 JSON 陣列");
  return parsed.map((item, i) => {
    const op = item as Partial<Op>;
    if (!op || typeof op.kind !== "string" || !kinds.has(op.kind) || !SLOTS.includes(op.slot as Slot) || typeof op.r !== "number") {
      throw new Error(`E2E_RANDOM_REPLAY 第 ${i + 1} 項不是有效操作：${JSON.stringify(item)}`);
    }
    return { kind: op.kind as OpKind, slot: op.slot as Slot, r: op.r };
  });
}

/** Tokens look like tk3k007z: fixed shape, never a prefix of another token. */
export const tokenFor = (run: number, n: number): string => `tk${run}k${String(n).padStart(3, "0")}z`;
export const TOKEN_RE = /tk\d+k\d{3}z/g;

/** Lines of a body, trimmed, blank ones dropped: what "same text" means here. */
export const bodyLines = (text: string): string[] =>
  text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;
