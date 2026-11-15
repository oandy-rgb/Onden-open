// 「分享 → Onden」: what another app hands us, turned into a quick-capture draft.
//
// Every way a share arrives ends up as one RawShare:
//   • the PWA's Web Share Target — the service worker stashes the POSTed form
//     (public/sw.js) and shareInbox.ts reads it back; an old GET share_target
//     still lands as `?capture=1&title=&text=&url=` (BuilderApp);
//   • the Android app — the ShareIntent native plugin (android/…/
//     ShareIntentPlugin.java) hands over EXTRA_SUBJECT / EXTRA_TEXT and the
//     shared images.
// PURE on purpose (no fetch, no React): parsing is the part with the edge
// cases, so it is the part under unit test (test/sharePayload.test.ts).

import { MEDIA_TYPES, mediaTypeOf } from "@onden/markdown";

/** A share as it arrived, before any interpretation. */
export type RawShare = {
  title?: string | null;
  text?: string | null;
  url?: string | null;
  files?: File[];
};

/** A share ready for quick capture. */
export type SharedCapture = {
  /** The shared link, if there is one (the first http(s) URL). */
  url: string | null;
  /** The text the capture box opens with. */
  draft: string;
  /** Images the server accepts, each named with an extension it knows. */
  images: File[];
  /** Names of shared files that cannot be attached (not an image the server
   *  accepts, e.g. HEIC) — the capture says so instead of dropping them. */
  skipped: string[];
};

const URL_RE = /\bhttps?:\/\/[^\s<>"'）」』】]+/i;
// Punctuation that ends a sentence, not the link.
const TRAILING = /[.,;:!?。，、；：！？)\]]+$/;

/** The first http(s) URL in a piece of text, or null. */
export function findUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = URL_RE.exec(text);
  if (!match) return null;
  const url = match[0].replace(TRAILING, "");
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const clean = (value: string | null | undefined): string => (value ?? "").replace(/\r\n?/g, "\n").trim();

// The extension a shared image's MIME type maps to on the server's table
// (image/jpeg → .jpg), so an unnamed image from Android can still be uploaded.
function extensionForMime(mime: string): string | null {
  const bare = mime.split(";")[0]!.trim().toLowerCase();
  for (const [ext, type] of Object.entries(MEDIA_TYPES)) {
    if (type.kind === "image" && type.mime === bare) return ext;
  }
  return null;
}

/** A shared file as an uploadable image, or null when the server would refuse
 *  it. The file is renamed only when its name lacks a known image extension. */
export function asUploadableImage(file: File, index: number): File | null {
  if (mediaTypeOf(file.name)?.kind === "image") return file;
  const ext = extensionForMime(file.type);
  if (!ext) return null;
  const stem = file.name.replace(/\.[^.]*$/, "").trim() || `shared-${index + 1}`;
  return new File([file], `${stem}${ext}`, { type: file.type });
}

/** Turn a raw share into the draft quick capture opens with.
 *
 *  • a link: the shared title (if any) on the first line, so it becomes the
 *    note's title, then the URL on its own line (GFM autolinks it); any other
 *    shared words follow. shareInbox swaps in the page's real title when the
 *    server can fetch it (draftWithTitle).
 *  • plain text: the text itself.
 *  • images: kept aside for upload on Save; they add no text. */
export function parseSharePayload(raw: RawShare): SharedCapture {
  const title = clean(raw.title);
  let text = clean(raw.text);
  const url = findUrl(raw.url) ?? findUrl(text) ?? findUrl(title);

  // Android puts the link inside EXTRA_TEXT ("Some page https://…"); a GET
  // share may repeat it in `url` and `text`. Say it once.
  if (url && text.includes(url)) text = clean(text.split(url).join(" ").replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n"));
  const heading = title && title !== url ? title : "";
  // Many apps send the page title as both subject and text.
  if (heading && text === heading) text = "";

  const lines: string[] = [];
  if (url) {
    if (heading) lines.push(heading);
    lines.push(url);
    if (text) lines.push("", text);
  } else {
    if (heading) lines.push(heading);
    if (text) lines.push(text);
  }

  const images: File[] = [];
  const skipped: string[] = [];
  (raw.files ?? []).forEach((file, index) => {
    const image = asUploadableImage(file, index);
    if (image) images.push(image);
    else skipped.push(file.name || `#${index + 1}`);
  });

  return { url, draft: lines.join("\n"), images, skipped };
}

/** Several shares at once (two arrived while the app was closed) as one capture. */
export function mergeShares(shares: SharedCapture[]): SharedCapture | null {
  if (shares.length === 0) return null;
  if (shares.length === 1) return shares[0]!;
  return {
    url: shares.find((s) => s.url)?.url ?? null,
    draft: shares.map((s) => s.draft).filter(Boolean).join("\n\n"),
    images: shares.flatMap((s) => s.images),
    skipped: shares.flatMap((s) => s.skipped),
  };
}

/** The draft with the page's fetched title as its first line: replaces a
 *  shared title (often just the site name) or is added above a bare URL. */
export function draftWithTitle(capture: SharedCapture, pageTitle: string | null | undefined): string {
  const fetched = clean(pageTitle).replace(/\s+/g, " ");
  if (!capture.url || !fetched || fetched === capture.url) return capture.draft;
  const lines = capture.draft.split("\n");
  const urlLine = lines.indexOf(capture.url);
  if (urlLine < 0) return capture.draft;
  return [fetched, ...lines.slice(urlLine)].join("\n");
}

/** A share's form fields (Web Share Target POST, multipart): `title`, `text`,
 *  `url` and any number of `images` files — the names the manifest declares. */
export function rawShareFromForm(form: FormData): RawShare {
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : null;
  };
  const files = form.getAll("images").filter((v): v is File => typeof v !== "string" && v.size > 0);
  return { title: field("title"), text: field("text"), url: field("url"), files };
}

/** A native share's file, as the Android plugin sends it (base64 bytes). */
export type NativeSharedFile = { name?: string | null; mimeType?: string | null; data: string };

/** Decode the Android plugin's base64 file into a File. */
export function fileFromNative(file: NativeSharedFile, index: number): File {
  const binary = atob(file.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], file.name || `shared-${index + 1}`, { type: file.mimeType || "application/octet-stream" });
}
