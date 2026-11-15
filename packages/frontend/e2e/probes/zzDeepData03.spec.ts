// Feature-audit deepening (2026-10-08): DATA-03 — workspace Markdown ZIP:
// what goes in (nested notes, tags, properties, tasks, canvas nodes,
// media), permission scope for a second human, the palette entry on desktop,
// a phone entry, and offline.
import { test } from "@playwright/test";
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ready, defaultSpaceId, hideFromOthers, seedLayout, addToDefaultSpace, BASE, H, PNG_1X1_B64 } from "../fullstack/helpers";

const PNG_B64 = PNG_1X1_B64; // a real image: the server decodes uploads

test("DATA-03: workspace zip contents, scope, entries, offline", async ({ page, browser, context }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  // Root notes in the default space so the second human's export includes them.
  const shared = await defaultSpaceId(page.request);
  const mk = async (data: Record<string, unknown>) => (await (await page.request.post("/api/nodes", { ...H, data: data.parent_id ? data : { space_id: shared, ...data } })).json()).id as string;
  const media = (await (await page.request.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: "z.png", mimeType: "image/png", buffer: Buffer.from(PNG_B64, "base64") } } })).json()).url as string;
  const P = await mk({ title: `ZipParent ${stamp}`, markdown: `parent ![img](${media})` });
  const K = await mk({ title: `ZipChild ${stamp}`, markdown: "child body", parent_id: P });
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `ziptag${stamp}`, fields: [{ name: "score", type: "number" }] } })).json();
  await page.request.put(`/api/nodes/${K}/tags/${tag.id}`, { ...H, data: {} });
  await page.request.put(`/api/nodes/${K}/attributes/score`, { ...H, data: { value: "9", value_type: "number" } });
  await page.request.post(`/api/nodes/${P}/tasks`, { ...H, data: { title: `ZipTask ${stamp}` } });
  const cv = await (await page.request.post("/api/canvases", { ...H, data: { title: `ZipBoard ${stamp}` } })).json();
  await seedLayout(page.request, cv.id, { ...H, data: { data: { nodes: [{ nodeId: P, x: 0, y: 0, width: 200 }] } } });
  const S = await mk({ title: `ZipSecret ${stamp}`, markdown: "secret body" });
  await hideFromOthers(page.request, S);
  const unzipList = (buf: Buffer) => { const d = mkdtempSync(join(tmpdir(), "zip-")); const f = join(d, "x.zip"); writeFileSync(f, buf); const names = JSON.parse(execSync(`python3 -c "import zipfile,json,sys;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))" "${f}"`).toString()) as string[]; return names.map((p) => ({ p, read: (n: string) => execSync(`python3 -c "import zipfile,sys;sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode('utf8','replace'))" "${f}" "${n}"`).toString() })); };
  const longest = (ents: Array<{ p: string }>) => ents.reduce((m, e) => Math.max(m, Buffer.byteLength(e.p.split("/").pop() ?? "")), 0);
  try {
  const res = await page.request.get("/api/export/markdown.zip");
  out.status = res.status();
  const ents = unzipList(Buffer.from(await res.body()));
  const mine = ents.filter((e) => e.p.includes(String(stamp)) || e.p.startsWith("attachments/"));
  out.total = ents.length;
  out.longestFileNameBytes = longest(ents);
  out.mine = mine.map((e) => e.p).filter((p) => p.includes(String(stamp))).slice(0, 12);
  out.attachments = ents.filter((e) => e.p.startsWith("attachments/")).length;
  const child = mine.find((e) => e.p.includes("zipchild"));
  out.childFile = child ? child.read(child.p).slice(0, 300) : null;
  const parent = mine.find((e) => e.p.includes("zipparent"));
  out.parentFile = parent ? parent.read(parent.p).slice(0, 300) : null;
  const board = ents.find((e) => e.p.includes(`canvas-${cv.id}`) || e.p.toLowerCase().includes("zipboard"));
  out.boardFile = board ? board.read(board.p).slice(0, 200) : "absent";
  out.taskInZip = ents.some((e) => e.p.toLowerCase().includes("ziptask")) || (parent ? parent.read(parent.p).includes("ZipTask") : false);
  out.tagPageFile = ents.some((e) => e.p.includes(`ziptag${stamp}`));
  out.secretForOwner = ents.some((e) => e.p.includes("zipsecret"));
  // Second human.
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `Z ${stamp}`, email: `z-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `Z ${stamp}`, type: "human", external_id: su.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const hr = await human.request.get("/api/export/markdown.zip");
  const hents = unzipList(Buffer.from(await hr.body()));
  out.editor = { status: hr.status(), total: hents.length, secret: hents.some((e) => e.p.includes("zipsecret")) };
  await human.close();
  // Desktop palette entry.
  await ready(page, "/?view=notes"); await page.waitForTimeout(800);
  await page.keyboard.press("Control+k"); await page.locator(".palette-input-wrap input").fill("Download all notes");
  await page.waitForTimeout(400);
  const dl = page.waitForEvent("download", { timeout: 20_000 }).catch(() => null);
  await page.locator(".palette-item, [role=option]").filter({ hasText: /Download all notes/ }).first().click();
  const d = await dl;
  out.paletteDownload = d ? d.suggestedFilename() : "none";
  // Offline.
  await context.setOffline(true); await page.waitForTimeout(500);
  await page.keyboard.press("Control+k"); await page.locator(".palette-input-wrap input").fill("Download all notes"); await page.waitForTimeout(400);
  const dl2 = page.waitForEvent("download", { timeout: 6000 }).catch(() => null);
  await page.locator(".palette-item, [role=option]").filter({ hasText: /Download all notes/ }).first().click().catch(() => {});
  out.offline = { download: !!(await dl2), toast: (await page.locator(".toast").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(-120), pages: context.pages().length };
  await context.setOffline(false);
  // Phone: is there an export entry in More / Settings?
  const ph = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await ph.newPage();
  await ready(pp, "/?view=notes");
  await pp.getByRole("button", { name: "More", exact: true }).filter({ visible: true }).first().click();
  await pp.waitForTimeout(500);
  out.phoneMore = (await pp.locator("[role=menu], dialog, .shell-dialog").filter({ visible: true }).first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
  await ph.close();
  } finally {
    await context.setOffline(false).catch(() => {});
    console.log("DATA03 " + JSON.stringify(out, null, 2));
  }
});
