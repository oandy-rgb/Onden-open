// Feature-audit loop probes (2026-10-07): TAG-05 relation / multi-value / media.
import { test } from "@playwright/test";
import { H } from "../fullstack/helpers";

test("TAG-05: server validation of relation, multi-value and media fields", async ({ page }) => {
  const stamp = Date.now();
  const person = await (await page.request.post("/api/tags/import", { ...H, data: { name: `Person${stamp}`, fields: [] } })).json();
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `Paper${stamp}`, fields: [
    { name: "author", type: "relation", relation_supertag: `Person${stamp}` },
    { name: "topics", type: "select", options: ["ml", "db", "os"], cardinality: "many" },
    { name: "cover", type: "media" },
  ] } })).json();
  const alice = await (await page.request.post("/api/nodes", { ...H, data: { title: `Alice ${stamp}`, markdown: "a" } })).json();
  await page.request.put(`/api/nodes/${alice.id}/tags/${person.id}`, { ...H, data: {} });
  const plain = await (await page.request.post("/api/nodes", { ...H, data: { title: `Plain ${stamp}`, markdown: "p" } })).json();
  const paper = await (await page.request.post("/api/nodes", { ...H, data: { title: `Paper ${stamp}`, markdown: "x" } })).json();
  await page.request.put(`/api/nodes/${paper.id}/tags/${tag.id}`, { ...H, data: {} });

  const put = async (key: string, data: Record<string, unknown>) => {
    const r = await page.request.put(`/api/nodes/${paper.id}/attributes/${key}`, { ...H, data });
    return `${r.status()} ${(await r.text()).slice(0, 140)}`;
  };
  console.log(`AUDIT TAG-05 relation→tagged person: ${await put("author", { value_ref: alice.id, value_type: "node_ref" })}`);
  console.log(`AUDIT TAG-05 relation→untagged note: ${await put("author", { value_ref: plain.id, value_type: "node_ref" })}`);
  console.log(`AUDIT TAG-05 relation→random uuid: ${await put("author", { value_ref: "00000000-0000-4000-8000-000000000000", value_type: "node_ref" })}`);
  console.log(`AUDIT TAG-05 relation as plain text value: ${await put("author", { value: "not-a-node" })}`);
  console.log(`AUDIT TAG-05 multi valid: ${await put("topics", { value: JSON.stringify(["ml", "db"]) })}`);
  console.log(`AUDIT TAG-05 multi invalid option: ${await put("topics", { value: JSON.stringify(["ml", "bogus"]) })}`);
  console.log(`AUDIT TAG-05 multi not-json: ${await put("topics", { value: "ml" })}`);
  console.log(`AUDIT TAG-05 media javascript: url: ${await put("cover", { value: "javascript:alert(1)" })}`);
  console.log(`AUDIT TAG-05 media https: ${await put("cover", { value: "https://example.com/a.png" })}`);
  const attrs = await (await page.request.get(`/api/nodes/${paper.id}/attributes`, H)).json();
  console.log(`AUDIT TAG-05 final attrs: ${JSON.stringify(attrs.map((a: { key: string; value: unknown; value_ref?: unknown }) => [a.key, a.value, a.value_ref])).slice(0, 400)}`);
});
