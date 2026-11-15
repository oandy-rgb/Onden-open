export type Summary = { unit: string; median: number; p95: number; min: number; max: number; runs: number[] };
export function summarize(samples: number[], unit: string): Summary;
export function timeMs(
  fn: () => unknown | Promise<unknown>,
  options?: { runs?: number; warmup?: number; prepare?: () => unknown | Promise<unknown> },
): Promise<Summary>;
