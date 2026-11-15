// 對照測試自己的測試：正規化不能把真正的差異吃掉，比對要抓得到「不在清單上的差異」與「清單上卻消失的差異」。
//   node --test packages/frontend/e2e/parity/parity.test.mjs        （npm run parity:test）
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLog } from "./normalize.mjs";
import { compareHosts, diffValues } from "./compare.mjs";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const entry = (step, body, extra = {}) => ({ step, status: 200, body, ...extra });

test("由宿主產生的 id 換成劇本裡的名字，時間戳與計數器拿掉", () => {
  const out = normalizeLog([entry("a", { id: U1, parent_id: U2, updated_at: "2026-11-06T10:03:14.374Z", last_event_id: "37", when_date: "2026-12-01", note: `see ${U1}` })], new Map([[U1, "A"], [U2, "B"]]));
  assert.deepEqual(out[0].body, { id: "{A}", last_event_id: "<n>", note: "see {A}", parent_id: "{B}", updated_at: "<time>", when_date: "2026-12-01" });
});

test("劇本沒命名的 uuid 不編號（位置會因範例資料移動），但仍然是 uuid", () => {
  const out = normalizeLog([entry("a", { x: U3 })], new Map());
  assert.equal(out[0].body.x, "{uuid}");
});

test("只有標了 unordered 的步驟會排序；其餘維持伺服器的順序", () => {
  const body = [{ n: 2 }, { n: 1 }];
  const [ordered, unordered] = normalizeLog([entry("o", body), entry("u", body, { unordered: true })], new Map());
  assert.deepEqual(ordered.body, [{ n: 2 }, { n: 1 }]);
  assert.deepEqual(unordered.body, [{ n: 1 }, { n: 2 }]);
});

test("diffValues 指到欄位路徑與清單長度", () => {
  assert.deepEqual(diffValues({ a: [1, 2], b: "x" }, { a: [1, 2, 3], b: "y" }).map((d) => d.path).sort(), [".a.length", ".b"]);
});

const run = (hostBody, hostStatus = 200) => [
  { host: "node", label: "Node", normalized: [entry("s", { v: 1 })] },
  { host: "browser", label: "Browser", normalized: [entry("s", hostBody, { status: hostStatus })] },
];
const known = (over = {}) => [{ id: "k1", step: "s", host: "browser", paths: [".v"], reason: "r", doc: "d", ...over }];

test("相同 → 通過；不同且不在清單上 → 失敗", () => {
  assert.equal(compareHosts(run({ v: 1 }), []).perHost.browser.unexpected.length, 0);
  assert.equal(compareHosts(run({ v: 2 }), []).perHost.browser.unexpected.length, 1);
});

test("清單上的差異算已知，不算失敗；狀態碼不同要另外列", () => {
  const ok = compareHosts(run({ v: 2 }), known());
  assert.equal(ok.perHost.browser.unexpected.length, 0);
  assert.equal(ok.perHost.browser.known.length, 1);
  assert.equal(compareHosts(run({ v: 1 }, 501), known()).perHost.browser.unexpected[0].path, "status");
});

test("清單上的差異沒出現 → 列為可移除；沒跑的宿主不算", () => {
  assert.deepEqual(compareHosts(run({ v: 1 }), known()).stale.map((k) => k.id), ["k1"]);
  assert.deepEqual(compareHosts([run({ v: 1 })[0]], known()).stale, []);
});

test("別的步驟、別的宿主上的差異不會被清單蓋掉", () => {
  assert.equal(compareHosts(run({ v: 2 }), known({ step: "other" })).perHost.browser.unexpected.length, 1);
  assert.equal(compareHosts(run({ v: 2 }), known({ host: "desktop" })).perHost.browser.unexpected.length, 1);
});

test("宿主少跑了一步或多了一步都是差異", () => {
  const results = run({ v: 1 });
  results[1].normalized.push(entry("extra", {}));
  assert.equal(compareHosts(results, []).perHost.browser.unexpected[0].step, "extra");
});
