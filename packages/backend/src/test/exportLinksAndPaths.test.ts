// Export rewrites links between notes but not code that shows one, and a
// trashed note's file name can't leave the .trash folder.
import { describe, it, expect } from "vitest";
import { rewriteLinks, vaultBases, type VaultIndexRow } from "../services/exportZip.js";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

const T = "`"; // a backtick, to keep the samples below readable
const link = `onden://node/${A}`;

describe("rewriteLinks", () => {
  const bases = new Map([[A, "Folder/Alpha"]]);
  it("rewrites a link in text and leaves inline code and fenced blocks as written", () => {
    const md = [
      `See [a](${link}) and ${T}${link}${T} and ${T}${T}x ${T}${link}${T} y${T}${T}.`,
      "",
      `${T.repeat(3)}md`,
      `[a](${link})`,
      T.repeat(3),
      "",
      `~~~\n${link}\n~~~`,
      "",
      `After: ${link}`,
    ].join("\n");
    const out = rewriteLinks(md, bases, "../");
    expect(out).toContain("[a](../Folder/Alpha.md) and");
    expect(out).toContain(`${T}${link}${T}`);
    expect(out).toContain(`${T}${T}x ${T}${link}${T} y${T}${T}`);
    expect(out).toContain(`${T.repeat(3)}md\n[a](${link})\n${T.repeat(3)}`);
    expect(out).toContain(`~~~\n${link}\n~~~`);
    expect(out).toContain("After: ../Folder/Alpha.md");
  });
  it("an unclosed fence runs to the end and a lone backtick is text", () => {
    const out = rewriteLinks(`it${T}s ${link}\n\n${T.repeat(3)}\n${link}`, bases);
    expect(out.split("\n")[0]).toBe(`it${T}s ./Folder/Alpha.md`);
    expect(out.endsWith(link)).toBe(true);
  });
});

describe("vaultBases", () => {
  const row = (id: string, slug: string | null, deleted: boolean): VaultIndexRow =>
    ({ id, slug, parent_id: null, title: slug ?? "", node_type: "content", hidden: false, deleted, has_text: true });
  it("a trashed note's slug can't make a nested or escaping path", () => {
    const bases = vaultBases([row(A, "../../etc/passwd", true), row(B, ".hidden/x", true)], false);
    expect(bases.get(A)).toBe(".trash/etc passwd");
    expect(bases.get(B)).toBe(".trash/hidden x");
    for (const base of bases.values()) expect(base.slice(".trash/".length)).not.toMatch(/[/\\]|^\./);
  });
});
