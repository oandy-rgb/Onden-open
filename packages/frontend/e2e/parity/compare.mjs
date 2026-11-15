// 比對：每個宿主的正規化紀錄 vs 基準（Node 後端那一欄）。差異分三種：
//   已知差異（在清單上）→ 算「已知」；不在清單上 → 失敗；清單上的差異沒出現 → 提示可以移除。
// 清單檔 scripts/parity-known-differences-baseline.json 的名字帶 baseline，所以 scripts/ratchet.mjs（只准減少）自動管它。
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const KNOWN_FILE = "scripts/parity-known-differences-baseline.json";

export function loadKnownDifferences(repo) {
  const raw = JSON.parse(readFileSync(join(repo, KNOWN_FILE), "utf8"));
  return Object.entries(raw.differences ?? {}).map(([id, d]) => ({ id, ...d }));
}

/** 兩個正規化值的差異路徑；清單長度不同就在 `path.length` 報一筆。 */
export function diffValues(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = a.length !== b.length ? [{ path: `${path}.length`, base: a.length, host: b.length }] : [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) out.push(...diffValues(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  if (isObj(a) && isObj(b)) {
    const out = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out.push({ path: `${path}.${k}`, base: undefined, host: b[k] });
      else if (!(k in b)) out.push({ path: `${path}.${k}`, base: a[k], host: undefined });
      else out.push(...diffValues(a[k], b[k], `${path}.${k}`));
    }
    return out;
  }
  return [{ path: path || ".", base: a, host: b }];
}

const covers = (known, diff, hostName) =>
  known.host === hostName && known.step === diff.step
  && (known.paths ?? [known.path]).some((path) => path === "*" || path === diff.path || diff.path.startsWith(`${path}.`) || diff.path.startsWith(`${path}[`));

/** @returns {{ perHost: Record<string,{ pass:number, unexpected:any[], known:any[], steps:number }>, stale:any[] }} */
export function compareHosts(results, known) {
  const base = results.find((r) => r.host === "node");
  const perHost = {};
  const used = new Set();
  const ran = new Set();
  for (const r of results) {
    if (!r.normalized) continue;
    ran.add(r.host);
    const entry = { pass: 0, unexpected: [], known: [], steps: r.normalized.length };
    perHost[r.host] = entry;
    if (r.host === "node" || !base?.normalized) {
      for (const s of r.normalized) {
        if (s.status === 0) entry.unexpected.push({ step: s.step, path: "status", base: "(連線)", host: "(連不上)" });
        else entry.pass++;
      }
      continue;
    }
    const bySteps = new Map(base.normalized.map((s) => [s.step, s]));
    for (const s of r.normalized) {
      const b = bySteps.get(s.step);
      if (!b) { entry.unexpected.push({ step: s.step, path: "step", base: "(沒有這一步)", host: "(有)" }); continue; }
      const diffs = [
        ...(b.status !== s.status ? [{ step: s.step, path: "status", base: b.status, host: s.status }] : []),
        ...diffValues(b.body, s.body, "").map((d) => ({ step: s.step, ...d })),
      ];
      if (diffs.length === 0) { entry.pass++; continue; }
      let allKnown = true;
      for (const d of diffs) {
        const k = known.find((x) => covers(x, d, r.host));
        if (k) { used.add(k.id); entry.known.push({ ...d, id: k.id }); } else { allKnown = false; entry.unexpected.push(d); }
      }
      if (allKnown) entry.pass += 0;
    }
    for (const b of base.normalized) if (!r.normalized.some((s) => s.step === b.step)) entry.unexpected.push({ step: b.step, path: "step", base: "(有)", host: "(這個宿主沒有跑到這一步)" });
  }
  const stale = known.filter((k) => ran.has(k.host) && !used.has(k.id));
  return { perHost, stale };
}

const show = (v) => { const s = v === undefined ? "(沒有)" : JSON.stringify(v); return s.length > 160 ? `${s.slice(0, 160)}…` : s; };

/** 印結果；回傳結束碼（0＝沒有未列入清單的差異、所有宿主都有跑）。 */
export function summarize(report, results, known) {
  let bad = 0;
  console.log("\n══ 三個宿主對照結果 ══");
  for (const r of results) {
    const s = report.perHost[r.host];
    if (r.skipped) { console.log(`${r.label}：略過（${r.skipped}）`); continue; }
    if (!s) { console.log(`${r.label}：沒有結果（${r.error ?? "?"}）`); bad++; continue; }
    const err = r.error ? `；${r.error}` : "";
    console.log(`${r.label}：通過 ${s.pass} 步／失敗 ${s.unexpected.length} 項差異／已知差異 ${s.known.length} 項（共 ${s.steps} 步）${err}`);
    if (r.error) bad++;
    for (const d of s.unexpected) { bad++; console.log(`  ✗ 「${d.step}」 ${d.path}\n      Node 基準：${show(d.base)}\n      ${r.label}：${show(d.host)}`); }
    for (const d of s.known) console.log(`  ≈ 已知 ${d.id}：「${d.step}」 ${d.path}`);
  }
  for (const k of report.stale) console.log(`  ⚑ 已知差異 ${k.id} 沒有出現了——可以從 ${"scripts/parity-known-differences-baseline.json"} 移除`);
  const skippedHosts = results.filter((r) => r.skipped).length;
  console.log(bad ? `\n未通過：${bad} 項（不在已知差異清單上的差異、或宿主沒跑起來）` : `\n通過（${known.length} 條已知差異在清單上${skippedHosts ? `，${skippedHosts} 個宿主具名略過` : ""}）`);
  return bad ? 1 : 0;
}
