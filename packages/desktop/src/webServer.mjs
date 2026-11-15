// 視窗載入的網址：同一個 127.0.0.1:埠 同時提供前端靜態檔，並把 /api 與 /health 轉給後端。
// 伺服器版靠 nginx 做同一件事（docker/nginx/nginx.conf）；這裡只做桌面版需要的那一小部分。
// 同源 → 不需要 CORS；瀏覽器端的本機資料（IndexedDB 等）綁在這個 origin，所以埠要盡量固定（desktop.json）。
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { LOOPBACK } from "./ports.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".map": "application/json",
};

/**
 * @param {{ webRoot: string, webPort: number, backendPort: number }} options
 * @returns {Promise<import("node:http").Server>}
 */
export function startWebServer({ webRoot, webPort, backendPort }) {
  // DNS rebinding：別的網站把自己的網域指向 127.0.0.1 後，瀏覽器會帶那個網域當 Host。只接受自己的名稱。
  const allowedHosts = new Set([`${LOOPBACK}:${webPort}`, `localhost:${webPort}`]);

  const server = createServer((req, res) => {
    if (!allowedHosts.has(req.headers.host ?? "")) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden host");
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      proxy(req, res, backendPort);
      return;
    }
    serveStatic(webRoot, url.pathname, req.method ?? "GET", res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(webPort, LOOPBACK, () => resolve(server));
  });
}

/** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res @param {number} backendPort */
function proxy(req, res, backendPort) {
  // 後端的登入限速信任 X-Real-IP（authClientIp.ts）：用戶端自帶的值不能通過。
  const headers = { ...req.headers, "x-real-ip": LOOPBACK, "x-forwarded-for": LOOPBACK };
  const upstream = httpRequest({ host: LOOPBACK, port: backendPort, method: req.method, path: req.url, headers }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res); // 直接接管：SSE（/api/events/stream）不能被緩衝
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "backend_unavailable" }));
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

/** @param {string} webRoot @param {string} pathname @param {string} method @param {import("node:http").ServerResponse} res */
async function serveStatic(webRoot, pathname, method, res) {
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const safe = normalize(decoded).replace(/^([/\\])+/, "");
  const file = join(webRoot, safe);
  if (file !== webRoot && !file.startsWith(webRoot + sep)) {
    res.writeHead(403).end();
    return;
  }
  let target = file;
  let info = await stat(target).catch(() => null);
  if (info?.isDirectory()) {
    target = join(file, "index.html");
    info = await stat(target).catch(() => null);
  }
  // 沒有副檔名的路徑是 App 內的畫面（/n/…），交給單頁應用；有副檔名卻不存在就是真的 404。
  if (!info?.isFile()) {
    if (extname(safe) !== "") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    target = join(webRoot, "index.html");
    info = await stat(target);
  }
  const hashed = pathname.startsWith("/_astro/");
  res.writeHead(200, {
    "content-type": MIME[/** @type {keyof typeof MIME} */ (extname(target).toLowerCase())] ?? "application/octet-stream",
    "content-length": info.size,
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(target).on("error", () => res.destroy()).pipe(res);
}
