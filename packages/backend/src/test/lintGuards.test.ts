// The lint guards of eslint.config.js, proven against code that breaks them.
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const eslint = new ESLint();

// The first lint of a file pays for the type-aware rules' TypeScript project (about 7 s); pay it here, not in the first test.
beforeAll(async () => { await eslint.lintText("export {};", { filePath: "src/modules/importers/shared/imageLinks.ts" }); }, 120_000);

async function messages(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

describe("Markdown parsers are imported only through @onden/markdown", () => {
  for (const name of ["unified", "remark-parse", "remark-gfm", "rehype-stringify", "micromark", "mdast-util-to-string"]) {
    it(`rejects ${name} in a service`, async () => {
      const found = await messages("src/modules/importers/shared/imageLinks.ts", `import x from "${name}";\nexport default x;`);
      expect(found.some((m) => m.includes("@onden/markdown"))).toBe(true);
    });
  }

  it("lets the static-site builder assemble its own pipeline", async () => {
    expect(await messages("src/modules/website/publishing/htmlUtils.ts", `import { unified } from "unified";\nexport default unified;`)).toEqual([]);
  });

  it("leaves the package's own entry and type-only dependencies alone", async () => {
    expect(await messages("src/services/x.ts", `import { parseGfmTree } from "@onden/markdown";\nimport type { Root } from "mdast";\nexport { parseGfmTree };\nexport type R = Root;`)).toEqual([]);
  });
});
