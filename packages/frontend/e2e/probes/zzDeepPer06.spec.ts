// Feature-audit deepening (2026-10-08, tick 10): PER-06 — read scope beyond
// the media API: anonymous reads of media in UNPUBLISHED notes, the public
// site and its media after the page is locked (moved to an owner-only space,
// which cannot publish) / unpublished, a removed
// member's leftover URLs, and a member's markdown.zip / export.html around a
// locked note embedded or linked from a readable one.
import { test, request as pwRequest } from "@playwright/test";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { defaultSpaceId, hideFromOthers, moveToSpace, addToDefaultSpace, publishSite, BASE, H } from "../fullstack/helpers";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("PER-06: media/site/export read scope", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const out: Record<string, unknown> = {};
  const req = page.request; const s = Date.now();
  const anon = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const up = async (n: string) => (await (await req.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: n, mimeType: "image/png", buffer: PNG } } })).json()).url as string;
  // Default space: it publishes, and member B sees it.
  let space_id = "";
  const mk = async (title: string, markdown: string) => (await (await req.post("/api/nodes", { ...H, data: { title, markdown, space_id } })).json()).id as string;
  const site = async () => await (await anon.get("/api/site")).text();
  try {
    space_id = await defaultSpaceId(req);
    // 1. Ordinary, unpublished, unlocked note.
    const u1 = await up(`plain-${s}.png`);
    const n1 = await mk(`P06 plain ${s}`, `private diary ![](${u1})`);
    out.anonMediaOfUnpublishedNote = (await anon.get(u1)).status();
    out.anonNodeOfUnpublishedNote = (await anon.get(`/api/nodes/${n1}`)).status();
    out.siteHasUnpublished = (await site()).includes(`P06 plain ${s}`);

    // 2. Published page, then locked, then unpublished.
    const u2 = await up(`pub-${s}.png`);
    const secret = await mk(`P06 Secret ${s}`, `classified-${s}`);
    await hideFromOthers(req, secret);
    const pub = await mk(`P06 Pub ${s}`, `public-${s} ![](${u2}) see [[P06 Secret ${s}]] and ![[P06 Secret ${s}]]`);
    await req.put(`/api/nodes/${pub}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
    await publishSite(req); // snapshot model B; the lock/unpublish below are live takedowns
    await page.waitForTimeout(2500);
    let st = await site();
    out.published = { page: st.includes(`public-${s}`), secretTitle: st.includes(`P06 Secret ${s}`), secretBody: st.includes(`classified-${s}`), media: (await anon.get(u2)).status() };
    await hideFromOthers(req, pub);
    await page.waitForTimeout(2500);
    st = await site();
    out.afterLock = { page: st.includes(`public-${s}`), media: (await anon.get(u2)).status() };
    await moveToSpace(req, pub, space_id);
    await req.put(`/api/nodes/${pub}/attributes/_published`, { ...H, data: { value: "false", value_type: "bool" } });
    await page.waitForTimeout(2500);
    st = await site();
    out.afterUnpublish = { page: st.includes(`public-${s}`), media: (await anon.get(u2)).status() };

    // 3. Member B: export around the locked note; then B is removed.
    const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const su = await (await ctx.request.post("/api/auth/sign-up/email", { ...H, data: { name: `P06 ${s}`, email: `p06-${s}@example.com`, password: `pw-${s}-x` } })).json();
    const actor = await (await req.post("/api/actors", { ...H, data: { name: `P06 ${s}`, type: "human", external_id: su.user.id } })).json();
    await addToDefaultSpace(req, actor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
    const u3 = await up(`secretimg-${s}.png`);
    await req.patch(`/api/nodes/${secret}`, { ...H, data: { markdown: `classified-${s} ![](${u3})` } });
    const host = await mk(`P06 Host ${s}`, `host-${s} ![[P06 Secret ${s}]] [[P06 Secret ${s}]]`);
    const zip = await ctx.request.get("/api/export/markdown.zip");
    out.zipStatus = zip.status();
    if (zip.ok()) {
      const f = `${process.env.TMPDIR ?? "/tmp"}/p06-${s}.zip`; writeFileSync(f, await zip.body());
      const py = (code: string) => execSync(`python3 -c ${JSON.stringify(code)} ${f}`).toString();
      const list = py("import zipfile,sys; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))");
      const hostMd = py(`import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(''.join(z.read(n).decode() for n in z.namelist() if 'P06 Host ${s}' in n))`);
      out.zip = { secretFile: list.includes(`P06 Secret ${s}`), secretImage: list.includes(u3.split("/").pop()!), hostHasSecretBody: hostMd.includes(`classified-${s}`), hostLink: hostMd.match(/\[\[[^\]]*\]\]|\]\([^)]*\)/g)?.slice(0, 3) };
    }
    const html = await ctx.request.get(`/api/nodes/${host}/export.html`);
    const htmlText = await html.text();
    out.exportHtml = { status: html.status(), secretBody: htmlText.includes(`classified-${s}`), secretTitle: htmlText.includes(`P06 Secret ${s}`) };
    const prev = await ctx.request.post(`/api/nodes/${host}/export-preview`, { ...H, data: { title: "x", markdown: `![[P06 Secret ${s}]] ![](${u3})` } });
    const prevText = await prev.text();
    out.exportPreview = { status: prev.status(), secretBody: prevText.includes(`classified-${s}`) };
    out.bReadsSecretImage = (await ctx.request.get(u3)).status();
    // B removed from the workspace: leftover session + anonymous.
    const del = await req.delete(`/api/actors/${actor.id}`, H);
    out.removeMember = del.status();
    out.removedMember = { session: (await ctx.request.get(u1)).status(), sessionNode: (await ctx.request.get(`/api/nodes/${n1}`)).status() };
    await ctx.close();
  } finally {
    await anon.dispose();
    console.log("PER06 " + JSON.stringify(out, null, 2));
  }
});
