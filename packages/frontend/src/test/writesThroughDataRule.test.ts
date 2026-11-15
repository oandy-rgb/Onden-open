// The writes-through-data lint rule: a write method in a raw api()/apiFetch()
// call is an error; reads, postRead and the data-layer helpers are fine.
import { describe, it } from "vitest";
import { RuleTester, type Rule } from "eslint";
import writesThroughData from "../../eslint-rules/writes-through-data.js";

const rule = writesThroughData as unknown as Rule.RuleModule;

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: "module" } });

tester.run("writes-through-data", rule, {
  valid: [
    "api('/api/nodes')",
    "api(`/api/nodes/${id}`, { signal })",
    "api('/api/x', { method: 'GET' })",
    "postRead('/api/query', spec)",
    "sendWrite('POST', '/api/spaces', { name })",
    "apiFetch(url, init)",
  ],
  invalid: [
    { code: "api('/api/spaces', { method: 'POST', body: '{}' })", errors: [{ messageId: "raw" }] },
    { code: "api(`/api/nodes/${id}`, { method: \"PATCH\" })", errors: [{ messageId: "raw" }] },
    { code: "apiFetch('/api/media', { method: 'post', body: form })", errors: [{ messageId: "raw" }] },
    { code: "fetch(url, { method: `DELETE` })", errors: [{ messageId: "raw" }] },
  ],
});
