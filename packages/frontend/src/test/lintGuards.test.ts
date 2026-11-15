// @vitest-environment node
// The lint guards of eslint.config.js, proven against code that breaks them.
// Flat config replaces (never merges) a rule's options when two blocks match
// one file, which once silently disabled a guard; asking ESLint what it
// resolves for a file is the only check that sees that.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function messages(filePath: string, code: string, ruleId: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.ruleId === ruleId).map((m) => m.message);
}

const QUEUE_IN_CATCH = `export async function save() { try { await send(); } catch { await queueWrite("POST", "/x", null); } }`;
const BARE_FETCH = "export const load = () => fetch(`${getApiBase()}/api/x`);";

describe("no-restricted-syntax", () => {
  it("rejects queueWrite() inside a catch in the data layer", async () => {
    const found = await messages("src/lib/data/draftActions.ts", QUEUE_IN_CATCH, "no-restricted-syntax");
    expect(found.some((m) => m.includes("queueWrite"))).toBe(true);
  });

  it("covers every file of the data layer, not a fixed few", async () => {
    const found = await messages("src/lib/data/someNewWriter.ts", QUEUE_IN_CATCH, "no-restricted-syntax");
    expect(found.some((m) => m.includes("queueWrite"))).toBe(true);
  });

  it("still rejects a bare fetch of a backend path in the data layer", async () => {
    const found = await messages("src/lib/data/draftActions.ts", BARE_FETCH, "no-restricted-syntax");
    expect(found.some((m) => m.includes("bare-fetch"))).toBe(true);
  });

  it("leaves queueWrite in a catch alone outside the data layer's rule scope", async () => {
    const found = await messages("src/lib/other.ts", QUEUE_IN_CATCH, "no-restricted-syntax");
    expect(found).toEqual([]);
  });
});

describe("no-restricted-imports", () => {
  const PARSERS = ["unified", "remark-gfm", "rehype-raw", "react-markdown", "micromark-util-types", "mdast-util-to-string"];

  it.each(PARSERS)("rejects %s outside the Markdown owners", async (name) => {
    const found = await messages("src/lib/someParser.ts", `import x from "${name}";\nexport default x;`, "no-restricted-imports");
    expect(found.some((m) => m.includes("@onden/markdown"))).toBe(true);
  });

  it("rejects it inside the data layer too", async () => {
    const found = await messages("src/lib/data/x.ts", `import { unified } from "unified";\nexport default unified;`, "no-restricted-imports");
    expect(found.some((m) => m.includes("@onden/markdown"))).toBe(true);
  });

  it("lets the renderer import react-markdown", async () => {
    const found = await messages("src/components/MarkdownRenderer.tsx", `import M from "react-markdown";\nexport default M;`, "no-restricted-imports");
    expect(found).toEqual([]);
  });

  it("still rejects localDb outside the data layer, and the renderer is not exempt from it", async () => {
    for (const file of ["src/lib/other.ts", "src/components/MarkdownRenderer.tsx"]) {
      const found = await messages(file, `import { x } from "../lib/localDb";\nexport default x;`, "no-restricted-imports");
      expect(found.some((m) => m.includes("lib/localDb"))).toBe(true);
    }
  });

  it("allows localDb inside the data layer", async () => {
    const found = await messages("src/lib/data/x.ts", `import { x } from "../localDb";\nexport default x;`, "no-restricted-imports");
    expect(found).toEqual([]);
  });
});

describe("onden/reads-through-data", () => {
  it("rejects a module reading through api() itself", async () => {
    const found = await messages("src/modules/rss/x.ts", `import { api } from "../../lib/api";\nexport default api;`, "onden/reads-through-data");
    expect(found).toHaveLength(1);
  });
});
