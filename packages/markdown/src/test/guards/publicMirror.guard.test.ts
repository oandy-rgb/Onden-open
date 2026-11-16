// Guard: the public repo is the private repo (scripts/public-mirror/README.md). The mirror used to run by itself on every
// push to main; when that stopped (2026-11-16) public main fell behind and nothing said so. Now two steps nobody can skip
// refuse to go on while public main is not private main: sending a branch to the public CI, and building a deploy.
// Both ask scripts/public-mirror/verify.sh, which is run here against two small repositories on disk.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../../../..");
const VERIFY = join(ROOT, "scripts/public-mirror/verify.sh");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

describe("public main is private main, or the next step stops", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const temp = () => { const d = mkdtempSync(join(tmpdir(), "mirror-")); dirs.push(d); return d; };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();

  /** A private repo with `origin` and `open` remotes, both bare, and one commit on main that is on all three. */
  function world() {
    const origin = temp(); const open = temp(); const work = temp();
    git(origin, "init", "-q", "--bare"); git(open, "init", "-q", "--bare");
    git(work, "init", "-q");
    git(work, "remote", "add", "origin", origin); git(work, "remote", "add", "open", open);
    const commit = (text: string) => {
      writeFileSync(join(work, "code.ts"), text);
      git(work, "add", "-A"); git(work, "commit", "-q", "-m", "work");
      git(work, "push", "-q", "origin", "HEAD:main");
      return git(work, "rev-parse", "HEAD");
    };
    /** What the mirror does, without the stripping: one public commit that names the private commit it was made from. */
    const mirror = (sha: string) => {
      const parent = spawnSync("git", ["rev-parse", "-q", "--verify", "refs/remotes/open/main"], { cwd: work, encoding: "utf8" }).stdout.trim();
      const made = git(work, "commit-tree", `${sha}^{tree}`, ...(parent ? ["-p", parent] : []), "-m", `同步：私人庫 ${sha.slice(0, 9)}（main）`);
      git(work, "push", "-q", "open", `${made}:refs/heads/main`);
      git(work, "fetch", "-q", "open");
    };
    const verify = () => {
      git(work, "fetch", "-q", "origin", "main");
      return spawnSync("bash", [VERIFY, git(work, "rev-parse", "origin/main")], { cwd: work, encoding: "utf8" });
    };
    return { work, commit, mirror, verify };
  }

  it("passes when public main was made from private main", () => {
    const { commit, mirror, verify } = world();
    mirror(commit("one"));
    const result = verify();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("stops when private main moved and the mirror did not follow", () => {
    const { commit, mirror, verify } = world();
    mirror(commit("one"));
    commit("two");
    const result = verify();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("expected");
  });

  it("stops when the public copy differs in a code file from the commit it names", () => {
    const { work, commit, mirror, verify } = world();
    const first = commit("one");
    mirror(first);
    const second = commit("two");
    // A public commit that claims to be `second` but carries `first`'s tree.
    const lying = git(work, "commit-tree", `${first}^{tree}`, "-m", `同步：私人庫 ${second.slice(0, 9)}（main）`);
    git(work, "push", "-q", "-f", "open", `${lying}:refs/heads/main`);
    const result = verify();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("DIFFERENCE");
  });

  it("sending a branch to the public repo asks first, and only main may go up while it is behind", () => {
    const push = read("scripts/public-mirror/public-push.sh");
    const gate = push.indexOf('bash "$here/verify.sh" "$(git rev-parse origin/main)"');
    expect(gate, "public-push.sh no longer checks that public main is private main").toBeGreaterThan(-1);
    expect(push.slice(0, gate)).toContain('if [ "$branch" != main ]; then');
    // The check comes before anything is removed, committed or pushed.
    expect(gate).toBeLessThan(push.indexOf("git checkout -q --detach"));
    expect(gate).toBeLessThan(push.indexOf("git push"));
  });

  it("building a deploy asks first", () => {
    const deploy = read("scripts/deploy-vps.sh");
    const build = deploy.slice(deploy.indexOf("\nbuild() {"), deploy.indexOf("\n}\n", deploy.indexOf("\nbuild() {")));
    const gate = build.indexOf("scripts/public-mirror/verify.sh");
    expect(gate, "deploy-vps.sh build no longer checks that public main is private main").toBeGreaterThan(-1);
    expect(gate).toBeLessThan(build.indexOf("\n  upload\n"));
  });
});
