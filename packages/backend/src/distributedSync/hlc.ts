// The clock lives in src/hlc.ts so write stamps can use it without importing this folder.
export { compareOps, tick, receive } from "../hlc.js";
