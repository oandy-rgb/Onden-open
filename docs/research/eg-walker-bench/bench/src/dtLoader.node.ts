// diamond-types（作者的 Rust 版，WASM 綁定）載入：Node 版。
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
export type Dt = typeof import("diamond-types-node");
export async function loadDt(): Promise<Dt> {
  const require = createRequire(import.meta.url);
  return require("diamond-types-node") as Dt;
}
export function dtWasmBytes(): Uint8Array {
  const require = createRequire(import.meta.url);
  return new Uint8Array(readFileSync(require.resolve("diamond-types-node/dt_bg.wasm")));
}
