// `npm run deploy:browser` and its pre-release scan (scripts/deploy-browser.mjs, scripts/browserReleaseScan.mjs):
// a folder with a secret is never copied, nothing is written outside --to, and a good build lands where asked.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isVendoredCopy, scanFolder, scanText } from "../../../../../scripts/browserReleaseScan.mjs";
import { deploy, parseArgs, safeSegment, targetFolder } from "../../../../../scripts/deploy-browser.mjs";

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), "browser-release-")); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

/** A minimal build: what deploy:browser looks for, plus whatever the test adds. */
function build(extra: Record<string, string> = {}): string {
  const dir = join(work, "dist");
  mkdirSync(join(dir, "assets"), { recursive: true });
  const files = { "index.html": "<html></html>", "worker.js": "export{};", "build.json": '{"build":"x"}', "worker.meta.json": '{"inputs":"/home/user/Onden/x"}', ...extra };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
const quiet = () => {};

describe("pre-release scan", () => {
  const kinds = (text: string) => scanText(text).map((f) => f.kind);
  it("finds key shapes, private-network addresses, IPs, emails and machine paths", () => {
    expect(kinds('const k = "sk-abcdefghijklmnopqrstuvwxyz0123";')).toContain("key");
    expect(kinds("-----BEGIN PRIVATE KEY-----")).toContain("key");
    expect(kinds("ghp_" + "a".repeat(36))).toContain("key");
    expect(kinds('fetch("http://192.168.1.20:3000/api")')).toEqual(expect.arrayContaining(["url"]));
    expect(kinds('fetch("https://wiki.internal/x")')).toContain("url");
    expect(kinds("host = 203.0.113.77")).toContain("ip");
    expect(kinds("mail me at someone@gmail.com")).toContain("email");
    expect(kinds("/home/andy/projects/onden/src/x.ts")).toContain("path");
    expect(kinds("C:\\Users\\andy\\work\\x")).toContain("path");
  });
  it("lets the build's own fixed strings through, and nothing broader", () => {
    expect(scanText('const origin = "http://localhost"; email: "me@this-browser.onden"')).toEqual([]);
    expect(scanText("ollama at http://localhost:11434 and 127.0.0.1")).toEqual([]);
    expect(scanText("version 1.2.3.4 and 10.0.0.0/8 and user@example.com")).toEqual([]);
    expect(scanText("/home/runner/work/puck/x.js /home/postgres/.pgpass")).toEqual([]);
  });
  it("scans a folder, skips the build's by-products and reports file and line", () => {
    const dir = build({ "assets/app.js": 'a\nb\nconst t = "ghp_' + "z".repeat(36) + '";' });
    const { findings } = scanFolder(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: join("assets", "app.js"), kind: "key", line: 3 });
  });
  it("leaves out a byte-for-byte copy of a dependency's file, and scans it again once one byte differs", () => {
    // 2026-11-23: the pdf.js worker's minified text holds a run that looks like an email, and stopped the release.
    const vendored = "/* pdf.js */ var a='jm@kbswfq.pkbgltMlwbaof';";
    const original = join(work, "pdf.worker.min.mjs");
    writeFileSync(original, vendored);
    const resolveDependency = (spec: string) => { expect(spec).toBe("pdfjs-dist/legacy/build/pdf.worker.min.mjs"); return original; };
    expect(scanFolder(build({ "pdf.worker.min.mjs": vendored }), resolveDependency).findings).toEqual([]);
    rmSync(join(work, "dist"), { recursive: true });
    const changed = scanFolder(build({ "pdf.worker.min.mjs": vendored + " // ops@gmail.com" }), resolveDependency).findings.map((f) => f.match);
    expect(changed).toEqual(["jm@kbswfq.pkbgltMlwbaof", "ops@gmail.com"]);
    rmSync(join(work, "dist"), { recursive: true });
    // Same text under a path that is not a vendored copy: scanned.
    expect(scanFolder(build({ "assets/app.js": vendored }), resolveDependency).findings).toHaveLength(1);
  });
  it("finds the vendored pdf.js worker in the installed package (the copy the real build ships)", () => {
    const shipped = readFileSync(join(__dirname, "../../../public/pdf.worker.min.mjs"));
    expect(isVendoredCopy("pdf.worker.min.mjs", shipped)).toBe(true);
    expect(isVendoredCopy("pdf.worker.min.mjs", Buffer.concat([shipped, Buffer.from(" ")]))).toBe(false);
  });
});

describe("deploy:browser", () => {
  it("reads its options and refuses what it does not know", () => {
    expect(parseArgs(["--to", "out", "--path=onden", "--tag", "v3", "--dry-run"])).toEqual({ dryRun: true, build: false, to: "out", path: "onden", tag: "v3" });
    expect(() => parseArgs(["--push"])).toThrow(/不認得/);
    expect(() => parseArgs(["--to"])).toThrow(/需要一個值/);
  });
  it("keeps the destination under --to", () => {
    for (const bad of ["..", "../x", "/etc", "a/../..", "a b", ""]) expect(() => safeSegment(bad, "--path")).toThrow();
    const { base, target } = targetFolder(join(work, "site"), "onden", "v3");
    expect(target).toBe(join(base, "onden", "v3"));
  });
  it("copies a clean build under the sub-path, leaves out by-products, and writes .nojekyll", () => {
    const from = build({ "assets/app.js": "console.log(1)" });
    const to = join(work, "site");
    const result = deploy({ to, path: "onden", from }, quiet);
    expect(result.copied).toBe(4);
    expect(existsSync(join(to, "onden", "index.html"))).toBe(true);
    expect(existsSync(join(to, "onden", "assets", "app.js"))).toBe(true);
    expect(existsSync(join(to, "onden", "worker.meta.json"))).toBe(false);
    expect(readFileSync(join(to, ".nojekyll"), "utf8")).toBe("");
  });
  it("puts a tagged version beside the others and replaces only that one", () => {
    const from = build();
    const to = join(work, "site");
    deploy({ to, path: "onden", tag: "v1", from }, quiet);
    writeFileSync(join(from, "build.json"), '{"build":"y"}');
    deploy({ to, path: "onden", tag: "v2", from }, quiet);
    deploy({ to, path: "onden", tag: "v1", from }, quiet);
    expect(JSON.parse(readFileSync(join(to, "onden", "v1", "build.json"), "utf8")).build).toBe("y");
    expect(existsSync(join(to, "onden", "v2", "index.html"))).toBe(true);
  });
  it("stops before copying anything when the scan finds a secret", () => {
    const from = build({ "assets/app.js": 'const k="sk-' + "q".repeat(30) + '"' });
    const to = join(work, "site");
    expect(() => deploy({ to, from }, quiet)).toThrow(/掃描沒有通過/);
    expect(existsSync(to)).toBe(false);
  });
  it("will not clear a destination that holds something else", () => {
    const from = build();
    const to = join(work, "site");
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "README.md"), "mine");
    expect(() => deploy({ to, from }, quiet)).toThrow(/不是瀏覽器版建置/);
    expect(readFileSync(join(to, "README.md"), "utf8")).toBe("mine");
  });
  it("does nothing in a dry run, and refuses a folder that is not a build", () => {
    const from = build();
    const to = join(work, "site");
    expect(deploy({ to, from, dryRun: true }, quiet).copied).toBe(0);
    expect(existsSync(to)).toBe(false);
    expect(() => deploy({ to, from: join(work, "nothing") }, quiet)).toThrow(/不是瀏覽器版的建置結果/);
  });
});
