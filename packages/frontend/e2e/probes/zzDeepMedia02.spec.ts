// Feature-audit deepening (2026-10-08, tick 9): MEDIA-02 — media read scope
// beyond PER-06: browser-cached copy after the embedding note is locked (moved
// to an owner-only space),
// assets whose only embedding note is trashed / edited out, an asset shared by
// a locked and an open note, attribute-only embedding, anonymous reads, and
// the download name / headers of a non-image upload.
import { test } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H } from "../fullstack/helpers";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("MEDIA-02: cached copies, orphaned-by-trash, shared refs, names", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {};
  const req = page.request;
  const stamp = Date.now();
  const upload = async (name: string, buf: Buffer, mimeType: string) => {
    const r = await req.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name, mimeType, buffer: buf } } });
    const j = await r.json().catch(() => ({}));
    if (!j.url) { (out.uploadErrors ??= [] as unknown[]); (out.uploadErrors as unknown[]).push({ name, status: r.status(), body: JSON.stringify(j).slice(0, 120) }); return ""; }
    return j.url as string;
  };
  // Default space: B must see a note until it is locked.
  let space_id = "";
  const note = async (title: string, markdown: string) => (await (await req.post("/api/nodes", { ...H, data: { title, markdown, space_id } })).json()).id as string;
  try {
    await ready(page, "/?view=notes");
    space_id = await defaultSpaceId(req);
    // B: a second editor in its own context.
    const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const su = await (await ctx.request.post("/api/auth/sign-up/email", { ...H, data: { name: `M02 ${stamp}`, email: `m02-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
    const editorActor = await (await req.post("/api/actors", { ...H, data: { name: `M02 ${stamp}`, type: "human", external_id: su.user.id } })).json();
    await addToDefaultSpace(req, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
    // "Lock" = move the note to an owner-only space.
    const lockNode = (id: string) => hideFromOthers(req, id);
    const bGet = async (u: string) => (await ctx.request.get(u)).status();
    const anon = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });

    // 1. Browser cache after revoke.
    const u1 = await upload(`cache-${stamp}.png`, PNG, "image/png");
    const n1 = await note(`M02 cache ${stamp}`, `![](${u1})`);
    const head = await ctx.request.get(u1);
    out.headers = { status: head.status(), cacheControl: head.headers()["cache-control"], vary: head.headers()["vary"] ?? null, ctype: head.headers()["content-type"] };
    const bp = await ctx.newPage();
    await bp.goto(`${BASE}/?view=notes`).catch(() => {});
    const loadImg = (u: string) => bp.evaluate(async (src) => {
      const img = new Image(); img.src = src;
      await new Promise((r) => { img.onload = r; img.onerror = r; setTimeout(r, 5000); });
      const f = await fetch(src).then((x) => x.status).catch((e) => String(e));
      return { naturalWidth: img.naturalWidth, fetchStatus: f };
    }, u);
    out.bBefore = await loadImg(u1);
    out.lockStatus = await lockNode(n1).then(() => "moved", (e) => String(e).slice(0, 120));
    out.bApiAfterLock = await bGet(u1);
    out.bBrowserAfterLock = await loadImg(u1);
    await bp.reload().catch(() => {}); await bp.waitForTimeout(1500);
    out.bBrowserAfterReload = await loadImg(u1);

    // 2. Only embedding note is locked, then trashed.
    const u2 = await upload(`trash-${stamp}.png`, PNG, "image/png");
    const n2 = await note(`M02 trash ${stamp}`, `secret ![](${u2})`);
    await lockNode(n2);
    out.trash = { bLocked: await bGet(u2), anonLocked: (await anon.request.get(u2)).status() };
    await req.delete(`/api/nodes/${n2}`, H);
    (out.trash as Record<string, unknown>).bAfterTrash = await bGet(u2);
    (out.trash as Record<string, unknown>).anonAfterTrash = (await anon.request.get(u2)).status();

    // 3. Locked note edits the image out (still in its history).
    const u3 = await upload(`edit-${stamp}.png`, PNG, "image/png");
    const n3 = await note(`M02 edit ${stamp}`, `![](${u3})`);
    await lockNode(n3);
    const before = await bGet(u3);
    await req.patch(`/api/nodes/${n3}`, { ...H, data: { markdown: "image removed" } });
    out.editedOut = { bLocked: before, bAfterEdit: await bGet(u3) };

    // 4. Shared by a locked and an open note.
    const u4 = await upload(`shared-${stamp}.png`, PNG, "image/png");
    const n4a = await note(`M02 sharedA ${stamp}`, `![](${u4})`);
    await note(`M02 sharedB ${stamp}`, `![](${u4})`);
    await lockNode(n4a);
    out.sharedOpenAndLocked = await bGet(u4);

    // 5. Attribute-only embedding on a locked node.
    const u5 = await upload(`attr-${stamp}.png`, PNG, "image/png");
    const n5 = await note(`M02 attr ${stamp}`, "x");
    await req.put(`/api/nodes/${n5}/attributes/cover`, { ...H, data: { value: u5 } });
    await lockNode(n5);
    out.attrOnlyLocked = await bGet(u5);

    // 6. Fresh upload, not yet embedded: who can read it.
    const u6 = await upload(`fresh-${stamp}.png`, PNG, "image/png");
    out.unattached = { b: await bGet(u6), anon: (await anon.request.get(u6)).status() };

    // 7. Non-image: name and headers.
    const u7 = await upload(`Contract Draft ${stamp}.txt`, Buffer.from("hello"), "text/plain");
    const r7 = await req.get(u7);
    out.txt = { url: u7, ctype: r7.headers()["content-type"], disposition: r7.headers()["content-disposition"] ?? null };
    const u8 = await upload(`notes-${stamp}.docx`, Buffer.from("PK\x03\x04 not really a docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    out.fakeDocx = { url: u8 ?? null };
    const u9 = await upload(`evil-${stamp}.png`, Buffer.from("<html><script>alert(1)</script></html>"), "image/png").catch((e) => String(e));
    out.htmlAsPng = u9;

    await ctx.close(); await anon.close();
  } finally {
    console.log("MEDIA02 " + JSON.stringify(out, null, 2));
  }
});
