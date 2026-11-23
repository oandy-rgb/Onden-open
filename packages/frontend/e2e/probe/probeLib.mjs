// The judgments of the daily production probe (prod-probe.mjs), kept apart so selftest.mjs can run them on made-up input.
// Nothing here opens a browser or reads a secret's value.

/** Words that are English on purpose in a Chinese screen (product and format names). Same idea as the list in
 *  e2e/fullstack/zzI18nAudit.spec.ts; a fresh browser profile holds no user content, so anything else English is UI chrome. */
const ALLOWED = /^(Onden|RSS|OPML|PDF|Markdown|BibTeX|DOI|URL|AI|API|CSS|HTML|JSON|Obsidian|Notion|Esc|Enter|Tab|Shift|Ctrl|Cmd|Alt|OK|ID|MCP|PWA|PNG|JPG|WebP|CSV|ZIP|SVG|PPTX|LaTeX|Anki|Zotero|GitHub|Google)$/i;
const WORD = /[A-Za-z][A-Za-z'’-]*/g;

/** The lines in `lines` that carry an English word of three or more letters outside ALLOWED (addresses are not words). */
export function englishUiStrings(lines) {
  const found = [];
  for (const line of lines) {
    const bare = String(line).replace(/https?:\/\/\S+/g, " ").replace(/\S+@\S+/g, " ");
    const words = (bare.match(WORD) ?? []).filter((w) => w.length >= 3 && !ALLOWED.test(w));
    if (words.length) found.push(String(line).trim().slice(0, 80));
  }
  return [...new Set(found)];
}

/** The server section needs three secrets. Missing any → the reason to print (and put in the report), else null.
 *  Names only; the values never go into a message. */
export function serverProbeSkipReason(env) {
  const missing = ["ONDEN_PROBE_URL", "ONDEN_PROBE_EMAIL", "ONDEN_PROBE_PASSWORD"].filter((k) => !env[k]);
  return missing.length ? `略過：巡檢帳號未設定（缺 ${missing.join("、")}）` : null;
}

/** Checks the baseline lists as 「known, waiting for a fix」: split a run's results into
 *  fresh reds (fail the run), known reds (listed, do not fail), and baseline entries that now pass (to delete from the list;
 *  the list only shrinks, scripts/ratchetLib.mjs). A baseline entry whose check did not run is neither. */
export function partitionResults(results, knownIds) {
  const known = new Set(Object.keys(knownIds));
  const fresh = results.filter((r) => !r.ok && !known.has(r.id));
  const knownRed = results.filter((r) => !r.ok && known.has(r.id));
  const removable = results.filter((r) => r.ok && known.has(r.id)).map((r) => r.id);
  return { fresh, knownRed, removable };
}

/** Remove the probe account's secrets from text before it is kept as an artifact. */
export function scrub(text, secrets) {
  let out = String(text);
  for (const s of secrets.filter((x) => x && x.length >= 3)) out = out.split(s).join("«已遮蔽»");
  return out;
}

/** Visible text of the page right now: the text people read plus title / aria-label / placeholder (what a screen shows or reads). */
export function visibleLinesInPage() {
  const lines = (document.body?.innerText ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const el of document.querySelectorAll("[title],[aria-label],[placeholder]")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    for (const a of ["title", "aria-label", "placeholder"]) { const v = el.getAttribute(a); if (v) lines.push(v.trim()); }
  }
  return lines;
}

/** Look at the page every `everyMs` until `done()` is true or `limitMs` passes. Returns every visible line seen, when it
 *  finished (null on timeout) and whether `gate` text was ever on screen. */
export async function sampleBoot(page, { done, limitMs, everyMs = 120, gate = /正在確認工作區資料|Checking your workspace/ }) {
  const seen = new Map(); // line → first time (ms) it was seen
  const start = Date.now();
  let gateSeen = false;
  let doneAt = null;
  while (Date.now() - start < limitMs) {
    const lines = await page.evaluate(visibleLinesInPage).catch(() => null); // null: the page is navigating
    if (lines) {
      for (const l of lines) if (!seen.has(l)) seen.set(l, Date.now() - start);
      if (lines.some((l) => gate.test(l))) gateSeen = true;
    }
    if (await done().catch(() => false)) { doneAt = Date.now() - start; break; }
    await page.waitForTimeout(everyMs);
  }
  return { lines: [...seen.keys()], doneAt, gateSeen };
}
