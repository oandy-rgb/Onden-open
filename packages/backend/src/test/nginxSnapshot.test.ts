// The snapshot route is a long stream in and out of the whole workspace: behind nginx it must not be buffered (the lines would arrive all at
// the end, or spool to a temp file), cached, cut at the 20 MB of the generic /api/ location, or have its upload read into a temp file before
// the backend has refused a caller that is not the owner. This checks the production config says so (docker/nginx/nginx.conf), as
// uploadCaps.test.ts does for the other large bodies.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const conf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../docker/nginx/nginx.conf"), "utf8");
const block = (header: string): string => {
  const from = conf.indexOf(header);
  expect(from, `${header} is in nginx.conf`).toBeGreaterThan(-1);
  return conf.slice(from, conf.indexOf("\n    }", from));
};

describe("nginx and the snapshot route", () => {
  const snapshot = block("location = /api/snapshot {");

  it("passes the stream through both ways and caches nothing", () => {
    expect(snapshot).toMatch(/proxy_buffering off;/);
    expect(snapshot).toMatch(/proxy_request_buffering off;/);
    expect(snapshot).toMatch(/proxy_cache off;/);
    expect(snapshot).toMatch(/gzip off;/);
    expect(snapshot).toMatch(/proxy_http_version 1\.1;/);
  });

  it("allows a body as large as a restore upload, and waits as long as one", () => {
    const megabytes = (text: string) => Number(/client_max_body_size (\d+)m;/.exec(text)![1]);
    expect(megabytes(snapshot)).toBeGreaterThanOrEqual(megabytes(block("location = /api/backup/restore/upload {")));
    expect(Number(/proxy_read_timeout (\d+)s;/.exec(snapshot)![1])).toBeGreaterThanOrEqual(600);
  });

  it("is an exact location, so it wins over the generic /api/ one", () => {
    expect(conf.indexOf("location = /api/snapshot {")).toBeGreaterThan(-1);
    expect(conf.indexOf("location = /api/snapshot {")).toBeLessThan(conf.indexOf("location /api/ {"));
  });
});
