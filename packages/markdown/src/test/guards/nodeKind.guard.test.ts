// Guard: two facts about a content node are written down once and used everywhere.
//   • "is a tag definition": the kind name `class_tag` is NODE_TYPE.tag in @onden/markdown/contract; the app asks
//     isTag(node) / isNote(node) / isCanvas(node), the server's SQL uses tagNodeSql / notTagNodeSql (backend spine/nodeSql.ts).
//   • "is not in the trash": liveNodeSql(alias) (backend spine/nodeSql.ts) instead of a spelled-out `deleted_at IS NULL`.
//
// This counts the quoted literal 'class_tag' / "class_tag" and the text `deleted_at IS NULL` in backend and frontend
// production source, and holds each file to its count in nodeKind.baseline.json. What is left there is on purpose
// (see the PR that introduced this: `spaces.deleted_at`, the sync copy in distributedSync, INSERT values, SQL fragments
// whose table alias a helper cannot know). The baseline only ratchets down: a new query uses the helpers.
// After removing some: UPDATE_NODEKIND_BASELINE=1 npx vitest run src/test/guards/nodeKind
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FILES } from "./sources";

const BASELINE = fileURLToPath(new URL("./nodeKind.baseline.json", import.meta.url));
const OWNERS = ["backend/src/spine/nodeSql.ts"];
const RAW = /(['"])class_tag\1|deleted_at IS NULL/g;

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { path, text } of FILES) {
    if (!/^(backend|frontend)\/src\//.test(path) || OWNERS.includes(path)) continue;
    const n = (text.match(RAW) ?? []).length;
    if (n > 0) out[path] = n;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

describe("the node kind and the live predicate have one owner", () => {
  const found = counts();
  if (process.env.UPDATE_NODEKIND_BASELINE === "1") writeFileSync(BASELINE, `${JSON.stringify(found, null, 2)}\n`);
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>;

  it("no file spells them out more often than its baseline", () => {
    const over = Object.entries(found).filter(([file, n]) => n > (baseline[file] ?? 0)).map(([file, n]) => `${file}: ${n} (baseline ${baseline[file] ?? 0})`);
    expect(over, "use isTag / isNote / isCanvas / NODE_TYPE (@onden/markdown/contract) or liveNodeSql / tagNodeSql / notTagNodeSql (backend spine/nodeSql.ts)").toEqual([]);
  });

  it("the guard still sees real uses (a regex that matched nothing would pass for nothing)", () => {
    expect(Object.keys(found).length).toBeGreaterThan(3);
    expect("a.node_type = 'class_tag' AND x.deleted_at IS NULL".match(RAW)).toHaveLength(2);
    expect(readFileSync(fileURLToPath(new URL("../../sharedContract.ts", import.meta.url)), "utf8")).toContain('tag: "class_tag"');
  });
});
