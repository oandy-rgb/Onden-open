// 四個實作的統一轉接。每個情境回傳 mk：呼叫 mk() 準備新鮮狀態（不計時），它回傳的函式才是被量的工作。
// 這個檔案 Node 與瀏覽器共用（不 import node:*）；diamond-types 由呼叫端注入。
import * as ref from "./vendor/eg-walker-reference/index.js";
import { buildRefLog } from "./refAdapter.js";
import { threeWayMergeBody } from "../../../../../packages/backend/src/services/eventLog/bodyMerge.js";
import { appendTxns, buildOpLog, makeBranch, mergeIntoBranch, replay } from "./proto/engine.js";
import { decodeHistory, encodeHistory } from "./proto/serialize.js";
import { TextBuf } from "./textBuf.js";
import { makeRemote, type RemoteEdit } from "./genFork.js";
import type { ForkScenario, History, Txn } from "./types.js";
import type { Dt } from "./dtLoader.node.js";

export type Prep = () => () => string;
export type ImplId = "diff3" | "ref" | "dt" | "proto";

export interface Impl {
  id: ImplId;
  label: string;
  /** (a) 只處理分岔那段：本機有 base＋A，遠端的 B 到來 */
  mergeFork?(sc: ForkScenario): Prep;
  /** (b) 整份歷史從頭重放 */
  replay?(h: History, extra?: { dtBytes?: Uint8Array; sc?: ForkScenario }): Prep;
  /** (c) 載入既有文件＋套一筆遠端修改 */
  loadApply?(sc: ForkScenario): Prep;
  /** 序列化後的歷史（沒有就不適用） */
  serialize?(h: History, extra?: { dtBytes?: Uint8Array; sc?: ForkScenario }): Uint8Array;
}

// ---- diff3 ----
export const diff3Impl: Impl = {
  id: "diff3",
  label: "現行 diff3（行）",
  mergeFork: (sc) => () => () => threeWayMergeBody(sc.base, sc.textB, sc.textA).merged,
  loadApply: (sc) => {
    const rm = makeRemote(sc);
    return () => () => threeWayMergeBody(rm.parentText, rm.remoteText, sc.textA).merged;
  },
};

// ---- 參考實作 ----
export const refImpl: Impl = {
  id: "ref",
  label: "eg-walker-reference",
  mergeFork(sc) {
    const log = buildRefLog(sc.history);
    const aHead = sc.rangeA[1] - 1;
    const snap = sc.textA.split("");
    return () => {
      const br: ref.Branch<string> = { snapshot: snap.slice(), version: [aHead] };
      return () => {
        ref.mergeChangesIntoBranch(br, log);
        return br.snapshot.join("");
      };
    };
  },
  replay(h) {
    const log = buildRefLog(h);
    return () => () => ref.checkoutSimpleString(log);
  },
  loadApply(sc) {
    const rm = makeRemote(sc);
    const json = JSON.stringify(rm.historyWithRemote);
    const aHead = sc.rangeA[1] - 1;
    return () => () => {
      const log = buildRefLog(JSON.parse(json) as History);
      const br: ref.Branch<string> = { snapshot: sc.textA.split(""), version: [aHead] };
      ref.mergeChangesIntoBranch(br, log);
      return br.snapshot.join("");
    };
  },
  serialize(h) {
    // 參考實作沒有檔案格式：以它的 oplog 做最直接的 JSON（逐字操作＋因果圖條目）
    const log = buildRefLog(h);
    return new TextEncoder().encode(JSON.stringify({ ops: log.ops, cg: log.cg.entries }));
  },
};

// ---- 我們的原型 ----
export const protoImpl: Impl = {
  id: "proto",
  label: "我們的 TS 原型",
  mergeFork(sc) {
    const log = buildOpLog(sc.history);
    const aHead = sc.rangeA[1] - 1;
    return () => {
      const br = makeBranch(sc.textA, [aHead]);
      return () => {
        mergeIntoBranch(br, log);
        return br.text.toString();
      };
    };
  },
  replay(h) {
    const log = buildOpLog(h);
    return () => () => replay(log);
  },
  loadApply(sc) {
    const rm = makeRemote(sc);
    const bytes = encodeHistory({ txns: rm.historyLocal.txns });
    const patch = encodeHistory({ txns: [rm.txn] });
    const aHead = sc.rangeA[1] - 1;
    return () => () => {
      const log = buildOpLog(decodeHistory(bytes));
      const br = makeBranch(sc.textA, [aHead]);
      appendTxns(log, decodeHistory(patch).txns);
      mergeIntoBranch(br, log);
      return br.text.toString();
    };
  },
  serialize: (h) => encodeHistory(h),
};

// ---- diamond-types ----
interface DtBuilt { bytes: Uint8Array; lvOf: (ourLv: number) => number; ol: InstanceType<Dt["OpLog"]> }

/** 依 History 建 DT oplog。shadowStart(i)＝第 i 筆交易所依據的文字（base 交易回傳 ""）。DT 以 unicode 字元計位。 */
function dtBuild(dt: Dt, h: History, shadowStart: (i: number) => string): DtBuilt {
  const ol = new dt.OpLog("base");
  const ends: Array<{ our0: number; ourLen: number; dtLast: number }> = [];
  const lvOf = (p: number): number => {
    for (const e of ends) if (p >= e.our0 && p < e.our0 + e.ourLen) {
      if (p !== e.our0 + e.ourLen - 1) throw new Error("DT 轉接：父版本落在操作中間（情境只會落在邊界）");
      return e.dtLast;
    }
    throw new Error(`DT 轉接：找不到 LV ${p}`);
  };
  let first = true;
  h.txns.forEach((t, i) => {
    ol.setAgent(t.agent);
    const shadow = TextBuf.from(shadowStart(i));
    let parents: number[] = t.parents.map(lvOf);
    let our = t.start;
    for (const [pos, del, ins] of t.ops) {
      const posCp = pos - shadow.astralBefore(pos);
      let last: number;
      if (del > 0) {
        const gone = shadow.slice(pos, del);
        const cp = [...gone].length;
        last = ol.del(posCp, cp, first && parents.length === 0 ? undefined : new Uint32Array(parents));
        shadow.delete(pos, del);
        ends.push({ our0: our, ourLen: del, dtLast: last });
        our += del;
      } else {
        last = ol.ins(posCp, ins, first && parents.length === 0 ? undefined : new Uint32Array(parents));
        shadow.insert(pos, ins);
        ends.push({ our0: our, ourLen: ins.length, dtLast: last });
        our += ins.length;
      }
      first = false;
      parents = [last];
    }
  });
  return { bytes: ol.toBytes(), lvOf, ol };
}

export function makeDtImpl(dt: Dt): Impl {
  const forkShadow = (sc: ForkScenario) => (i: number) => (i === 0 ? "" : sc.base);
  return {
    id: "dt",
    label: "diamond-types（WASM）",
    mergeFork(sc) {
      // 伺服器端 doc＝base＋A；B 以補丁（DT 的線上格式）到來
      const baseA = dtBuild(dt, { txns: sc.history.txns.slice(0, 2) }, forkShadow(sc));
      const bytesBA = baseA.bytes;
      const verBA = baseA.ol.getLocalVersion();
      const full = dtBuild(dt, sc.history, forkShadow(sc));
      const patchB = full.ol.getPatchSince(verBA);
      return () => {
        const doc = dt.Doc.fromBytes(bytesBA, "srv");
        return () => {
          doc.mergeBytes(patchB);
          const s = doc.get();
          doc.free();
          return s;
        };
      };
    },
    replay(h, extra) {
      const bytes = extra?.dtBytes ?? dtBuild(dt, h, forkShadow(extra!.sc!)).bytes;
      const ol = dt.OpLog.fromBytes(bytes);
      return () => () => {
        const br = ol.checkout();
        const s = br.get();
        br.free();
        return s;
      };
    },
    loadApply(sc) {
      const rm: RemoteEdit = makeRemote(sc);
      const local = dtBuild(dt, rm.historyLocal, forkShadow(sc));
      const bytesLocal = local.bytes;
      const verLocal = local.ol.getLocalVersion();
      // 遠端那筆的父版本在 A 裡面：把它接到同一個 oplog 上取補丁
      const parentDt = local.lvOf(rm.txn.parents[0]!);
      local.ol.setAgent("R");
      local.ol.ins(rm.txn.ops[0]![0] - TextBuf.from(rm.parentText).astralBefore(rm.txn.ops[0]![0]), rm.txn.ops[0]![2], new Uint32Array([parentDt]));
      const patchR = local.ol.getPatchSince(verLocal);
      return () => () => {
        const doc = dt.Doc.fromBytes(bytesLocal, "srv");
        doc.mergeBytes(patchR);
        const s = doc.get();
        doc.free();
        return s;
      };
    },
    serialize(h, extra) {
      return extra?.dtBytes ?? dtBuild(dt, h, forkShadow(extra!.sc!)).bytes;
    },
  };
}

export type { Txn };
