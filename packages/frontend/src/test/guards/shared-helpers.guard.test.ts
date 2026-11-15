// @vitest-environment node
// Guard: small jobs that used to be written once per caller stay in their one helper.
// Each block names the helper that owns the job; an exception says why it is one.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { entryHint } from "../../../../../scripts/entrypointsCatalog.mjs";
import { SRC, findUses, sourceFiles } from "./sources";

const files = [...sourceFiles("components"), ...sourceFiles("hooks"), ...sourceFiles("lib"), ...sourceFiles("modules"),
  ...sourceFiles("pages"), ...sourceFiles("settings")];

describe("newest-updated-first order is lib/noteOrder's byUpdatedDesc", () => {
  it("no list compares updated_at by hand", () => {
    expect(findUses(files, /updated_at \?\? ""\)\.localeCompare/, ["lib/noteOrder.ts"]), entryHint("updated-order")).toEqual([]);
  });
});

describe("saving a file to disk is lib/download's downloadBlob", () => {
  it("only downloadBlob sets an <a download> name", () => {
    expect(findUses(files, /\.download\s*=/, [
      "lib/download.ts",
      "hooks/useNodeCreation.ts", // a server URL (the zip export), not a blob
    ]), entryHint("save-file-download")).toEqual([]);
  });
});

describe("hex and SHA-256 are lib/hex's", () => {
  it("no byte-to-hex loop or crypto.subtle.digest outside it", () => {
    expect(findUses(files, /toString\(16\)\.padStart\(2|subtle\.digest/, [
      "lib/hex.ts",
      "lib/ink/hsv.ts", // a colour channel, not bytes
      "modules/importers/excalidraw.ts", // a colour channel, not bytes
      "modules/rss/rssQuote.ts", // percent-escapes one character
    ]), entryHint("hex-sha256")).toEqual([]);
  });
});

describe("clamping a number to 0..1 is lib/ink/color's clamp01", () => {
  it("is defined once", () => {
    expect(findUses(files, /(?:const|function)\s+clamp01\b/, ["lib/ink/color.ts"]), entryHint("clamp01")).toEqual([]);
  });
});

describe("a YYYY-MM month key is lib/localDate's monthId", () => {
  it("nobody pads getMonth() + 1 by hand", () => {
    expect(findUses(files, /(?:getMonth\(\)|month) \+ 1\)\.padStart/, ["lib/localDate.ts"]), entryHint("workspace-today")).toEqual([]);
  });
});

describe("saving when the page goes away is lib/pageHide's onPageHide", () => {
  it("no file pairs pagehide with visibilitychange itself", () => {
    const own = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      return /["']pagehide["']/.test(text) && /visibilityState === ["']hidden["']/.test(text);
    }).map((file) => file.slice(SRC.length + 1));
    expect(own).toEqual(["lib/pageHide.ts"]);
  });
});

describe("turning a value and its merge base into a patch is lib/data/patchedBody's", () => {
  it("only patchedBody calls makePatch (docs/architecture/patch-writes.md)", () => {
    expect(findUses(files, /\bmakePatch\(/, ["lib/data/patchedBody.ts"])).toEqual([]);
  });
});
