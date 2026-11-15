// npm run build:browser (repo root), then: node e2e/browser-app/bigInk.mjs
// The browser app's own database (PGlite) with a drawing over the chunk threshold (backend services/inkChunks.ts, migration 203):
// saved twice, read back whole (the note and its History list), still there after a reload, and carried by a backup that is
// restored into a second space (the copy holds the same drawing, byte for byte). Exit code 1 when a check fails.
import { launch, startSite, openApp, waitSaved, VIEWPORTS } from "../layout-audit/env.mjs";

const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(what); };

const browser = await launch();
const site = await startSite();
const { page } = await openApp(browser, site, VIEWPORTS.find((v) => v.id === "1280"), { seed: false });
const NOTE = "00000000-0000-4000-8000-0000000e0001";
const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}, { method, path, body });

// A PDF-shaped drawing of about 250 K characters: many strokes of 30 points.
const drawing = (strokes) => JSON.stringify({
  version: 1, pages: { 1: { version: 1, strokes: Array.from({ length: strokes }, (_, i) => ({ id: `s${i}`, color: "#000000", size: 2, toolId: "pen", points: Array.from({ length: 30 }, (_, k) => [i + k * 1.2345678, i * 2.3456789 + k, 0.5]) })), erased: {}, page: { width: 1000 } } }, annotations: [],
});
const v1 = drawing(230), v2 = drawing(240);
check(v1.length > 192 * 1024, "the drawing is over the chunk threshold", `${v1.length} chars`);

try {
  await call("POST", "/api/nodes", { id: NOTE, title: "大張手寫", markdown: "x" });
  await call("PUT", `/api/nodes/${NOTE}/attributes/ink_data`, { value: v1, value_type: "text" });
  await call("PUT", `/api/nodes/${NOTE}/attributes/ink_data`, { value: v2, value_type: "text", base_value: v1 });
  await waitSaved(page);
  const stored = async () => (await call("GET", `/api/nodes/${NOTE}/attributes?keys=ink_data`)).find((a) => a.key === "ink_data")?.value;
  check(await stored() === v2, "the note holds the second drawing");
  const versions = await call("GET", `/api/nodes/${NOTE}/ink-versions`);
  check(versions.length === 2 && versions[0].ink_data === v2 && versions[1].ink_data === v1, "History lists both versions whole");

  await page.reload();
  await page.waitForTimeout(3000);
  check(await stored() === v2, "after a reload the drawing is still there");
  const again = await call("GET", `/api/nodes/${NOTE}/ink-versions`);
  check(again.length === 2 && again[1].ink_data === v1, "after a reload History still reads the earlier version");

  // Backup, then restore into a second space.
  const spaces = await call("GET", "/api/spaces");
  const home = (Array.isArray(spaces) ? spaces : spaces.spaces).find((s) => s.is_default) ?? (Array.isArray(spaces) ? spaces : spaces.spaces)[0];
  const into = await call("POST", "/api/spaces", { name: "還原到這裡" });
  const uploaded = await page.evaluate(async () => {
    const zip = await (await fetch("/api/backup/full.zip")).arrayBuffer();
    const r = await fetch("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: zip });
    return { status: r.status, body: await r.json() };
  });
  check(uploaded.status === 200, "the backup uploads for a restore", `${uploaded.status}`);
  await call("POST", `/api/backup/restore/${uploaded.body.upload_id}/apply`, { space_id: into.id, mode: "empty" });
  let copy = null;
  for (let i = 0; i < 60 && !copy; i++) {
    await page.waitForTimeout(500);
    const hits = await call("GET", `/api/nodes/search?q=${encodeURIComponent("大張手寫")}`).catch(() => []);
    copy = (Array.isArray(hits) ? hits : []).find((n) => n.title === "大張手寫" && n.id !== NOTE) ?? null;
  }
  check(!!copy, "the restored space has the note", home ? "" : "(no default space found)");
  if (copy) {
    const value = (await call("GET", `/api/nodes/${copy.id}/attributes?keys=ink_data`)).find((a) => a.key === "ink_data")?.value;
    check(value === v2, "the restored note holds the same drawing, byte for byte");
  }
} catch (error) {
  check(false, "the run finished", String(error.message ?? error));
}
await browser.close();
site.close?.();
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
