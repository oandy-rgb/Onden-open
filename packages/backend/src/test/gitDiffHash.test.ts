// getDiff hands its argument to `git show`. Only a commit id may get there:
// anything starting with `-` is an option to git (`--output=<file>` writes one).
import { describe, it, expect, vi, beforeEach } from "vitest";

const show = vi.fn(async (_args: string[]) => "diff text");
vi.mock("simple-git", () => ({ simpleGit: () => ({ show }) }));

import { getDiff } from "../git.js";

beforeEach(() => show.mockClear());

describe("getDiff only passes a commit id to git", () => {
  it.each(["deadbee", "0123456789abcdef0123456789abcdef01234567"])("shows %s", async (hash) => {
    expect(await getDiff(hash)).toBe("diff text");
    expect(show).toHaveBeenCalledWith([hash]);
  });

  it.each([
    "--output=.auth-secret",
    "-p",
    "HEAD",
    "deadbeef --output=x",
    "deadbeef\n--output=x",
    "DEADBEEF",
    "abc",
    "",
  ])("answers nothing for %j and never runs git", async (hash) => {
    expect(await getDiff(hash)).toBe("");
    expect(show).not.toHaveBeenCalled();
  });
});
