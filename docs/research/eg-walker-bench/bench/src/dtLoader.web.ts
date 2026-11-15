// diamond-types：瀏覽器版（WebAssembly，同步初始化以便把「載入」與「合併」分開量）。
import * as web from "diamond-types-web";
export type Dt = typeof web;
let ready: Promise<Dt> | null = null;
export function loadDt(): Promise<Dt> {
  ready ??= (async () => {
    const buf = await (await fetch("/dt_bg.wasm")).arrayBuffer();
    web.initSync(buf);
    return web;
  })();
  return ready;
}
