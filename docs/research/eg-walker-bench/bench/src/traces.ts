// 論文公開 trace 讀取（Node 專用；瀏覽器版由 runBrowser 以 fetch 取得同一份 JSON）。
// 單位＝trace 的 unicode 字元。非 BMP 字元（emoji 等）換成 U+FFFD 讓「一個字元＝一個 UTF-16 單位」，
// 位置不受影響（editing-traces 的 ascii_only 變體做的是同類處理）。
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { History, PatchOp, Txn } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(here, "..", "data");

const flat = (s: string): string => s.replace(/[\u{10000}-\u{10FFFF}]/gu, "�");

export interface TraceMeta { id: string; label: string; kind: "sequential" | "concurrent"; dtFile: string; astral: number }
export interface Trace extends TraceMeta { history: History }

interface RawTxn { span: [number, number]; parents: number[]; agent: string; seqStart: number; ops: PatchOp[] }

function fromDtExport(j: { txns: RawTxn[]; endContent: string }, countAstral: (n: number) => void): History {
  const txns: Txn[] = j.txns.map((t) => ({
    agent: t.agent,
    start: t.span[0],
    parents: t.parents,
    ops: t.ops.map(([p, d, s]): PatchOp => {
      countAstral((s.match(/[\u{10000}-\u{10FFFF}]/gu) ?? []).length);
      return [p, d, flat(s)];
    }),
  }));
  return { txns, endContent: flat(j.endContent) };
}

function fromSequential(j: { startContent: string; endContent: string; txns: Array<{ patches: PatchOp[] }> }): History {
  const ops: PatchOp[] = [];
  for (const t of j.txns) for (const [p, d, s] of t.patches) {
    if (d > 0) ops.push([p, d, ""]);
    if (s.length > 0) ops.push([p + 0, 0, flat(s)]);
  }
  // 「先刪再插」的 patch 要保持原順序：上面已依序 push（刪在前、插在後），位置相同。
  return { txns: [{ agent: "seq", start: 0, parents: [], ops }], endContent: flat(j.endContent) };
}

function fromConcurrent(j: { endContent: string; txns: Array<{ parents: number[]; agent: number; patches: PatchOp[] }> }): History {
  const txns: Txn[] = [];
  const endLv: number[] = [];
  let lv = 0;
  for (const t of j.txns) {
    const ops: PatchOp[] = [];
    for (const [p, d, s] of t.patches) {
      if (d > 0) ops.push([p, d, ""]);
      if (s.length > 0) ops.push([p, 0, flat(s)]);
    }
    const units = ops.reduce((n, o) => n + (o[1] > 0 ? o[1] : o[2].length), 0);
    txns.push({ agent: `a${t.agent}`, start: lv, parents: t.parents.map((i) => endLv[i]!), ops });
    lv += units;
    endLv.push(lv - 1);
  }
  return { txns, endContent: flat(j.endContent) };
}

const readJson = (f: string) => JSON.parse(readFileSync(join(DATA_DIR, f), "utf8"));
const readGz = (f: string) => JSON.parse(gunzipSync(readFileSync(join(DATA_DIR, f))).toString("utf8"));

export const TRACE_LIST: Array<Omit<TraceMeta, "astral">> = [
  { id: "automerge-paper", label: "automerge-paper（單人，26 萬次按鍵）", kind: "sequential", dtFile: "automerge-paper.dt" },
  { id: "seph-blog1", label: "seph-blog1（單人，部落格長文）", kind: "sequential", dtFile: "seph-blog1.dt" },
  { id: "friendsforever", label: "friendsforever（2 人並行）", kind: "concurrent", dtFile: "friendsforever.dt" },
  { id: "clownschool", label: "clownschool（2 人並行）", kind: "concurrent", dtFile: "clownschool.dt" },
  { id: "node_nodecc", label: "node_nodecc（多人，git 歷史）", kind: "concurrent", dtFile: "node_nodecc.dt" },
  { id: "git-makefile", label: "git-makefile（多人，git 歷史）", kind: "concurrent", dtFile: "git-makefile.dt" },
];

export function loadTrace(id: string): Trace {
  const meta = TRACE_LIST.find((t) => t.id === id);
  if (!meta) throw new Error(`未知 trace ${id}`);
  let astral = 0;
  const count = (n: number) => { astral += n; };
  let history: History;
  switch (id) {
    case "automerge-paper": case "seph-blog1": history = fromSequential(readGz(`${id}.json.gz`)); break;
    case "clownschool": history = fromConcurrent(readGz("clownschool.json.gz")); break;
    case "friendsforever": history = fromDtExport(readJson("ff-raw.json"), count); break;
    default: history = fromDtExport(readJson(`${id}-raw.json`), count);
  }
  return { ...meta, astral, history };
}

export const dtBytes = (file: string): Uint8Array => new Uint8Array(readFileSync(join(DATA_DIR, file)));
