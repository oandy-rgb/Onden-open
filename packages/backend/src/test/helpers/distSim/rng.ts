/** Small deterministic generator (mulberry32): the seed alone reproduces a run. */
export type Rng = { next(): number; int(n: number): number; pick<T>(xs: readonly T[]): T; chance(p: number): boolean };
export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (xs) => xs[Math.floor(next() * xs.length)]!, chance: (p) => next() < p };
}
