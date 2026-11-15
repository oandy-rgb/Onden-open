// The reverse proxy adds the browser-hardening headers the app and Astro do
// not send themselves. /site/* keeps its own X-Frame-Options (SiteHead.astro),
// so the proxy skips it there. No CSP yet. Reads the config text; the headers
// were also checked against a real nginx when this was written.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const conf = readFileSync(new URL("../../../../docker/nginx/nginx.conf", import.meta.url), "utf8");

describe("nginx security headers", () => {
  it("sends the three headers on every response, including error pages", () => {
    expect(conf).toMatch(/add_header X-Frame-Options \$frame_options always;/);
    expect(conf).toMatch(/add_header X-Content-Type-Options nosniff always;/);
    expect(conf).toMatch(/add_header Referrer-Policy strict-origin-when-cross-origin always;/);
  });
  it("denies framing of app routes but not /site/*", () => {
    const map = /map \$uri \$frame_options \{([\s\S]*?)\}/.exec(conf)![1]!;
    expect(map).toMatch(/\^\/site\/\s+"";/);
    expect(map).toMatch(/default\s+DENY;/);
  });
  it("repeats them in the one location that has its own add_header", () => {
    const astro = /location \/_astro\/ \{([\s\S]*?)\n    \}/.exec(conf)![1]!;
    for (const h of ["X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy"]) expect(astro).toContain(`add_header ${h}`);
  });
  it("adds no Content-Security-Policy", () => {
    expect(conf).not.toMatch(/add_header Content-Security-Policy/i);
  });
});
