// Cost of sending personal writes through the one write entry (spine/mutate.ts mutatePersonal, S4), through the real services on an
// in-memory PGlite: 1,000 preference writes and 1,000 review grades (20 cards x 50 grades), one transaction each. The same file runs
// on both sides of the change (it only calls services that exist before and after), so run it on each tree and compare:
//   npx tsx scripts/measure-personal-cost-s4.mts
import { performance } from "node:perf_hooks";
import { setEnvironment } from "../src/config.js";

setEnvironment({
  NODE_ENV: "production", ONDEN_DB_DRIVER: "pglite", ONDEN_PGLITE_DIR: "memory://",
  BETTER_AUTH_SECRET: "measure-only-never-used-to-sign-a-session", BETTER_AUTH_URL: "http://localhost", LOG_LEVEL: "warn",
});
const { migrate, q, getWorkspaceId } = await import("../src/db.js");
const { createNote } = await import("../src/services/noteCreate.js");
const { applyTagToNode } = await import("../src/services/tagMembershipWrites.js");
const { writePref } = await import("../src/services/actorPrefs.js");
const { grade } = await import("../src/modules/review/service.js");
const { seedClassTag } = await import("../src/test/helpers/seedClassTag.js");
const { registerShippedModules } = await import("../src/test/helpers/registerShippedModules.js");
const { setModulesOn } = await import("../src/test/helpers/setModulesOn.js");
await registerShippedModules();
await migrate();
const ws = await getWorkspaceId();
await setModulesOn(ws, null);
const actorId = (await q<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'measure', 'human') RETURNING id::text`, [ws])).rows[0]!.id;
await q(`INSERT INTO space_members (space_id, actor_id, permission)
         SELECT s.id, $2, 'edit' FROM spaces s WHERE s.workspace_id = $1 AND s.is_default ON CONFLICT (space_id, actor_id) DO NOTHING`, [ws, actorId]);
const actor = { id: actorId, name: "measure", type: "human" as const, role: "admin" as const };
const spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;

const tagId = (await seedClassTag(ws, { name: "measure-review", behaviour: { modules: { review: { enabled: true } } } })).tagId;
const cards: string[] = [];
for (let i = 0; i < 20; i++) {
  const id = (await createNote({ actor, workspaceId: ws, title: `card ${i}`, markdown: "body", spaceId, event: { uiContext: "node.create" } })).node.id;
  await applyTagToNode({ workspaceId: ws, actor, nodeId: id, tagId });
  cards.push(id);
}

const ms = (t: number) => Math.round(performance.now() - t);
const result: Record<string, number> = {};
let t = performance.now();
for (let i = 0; i < 1000; i++) await writePref(actor, "dayNoteParent", i % 7 === 6 ? null : crypto.randomUUID());
result.prefs_1000_ms = ms(t);
t = performance.now();
for (let i = 0; i < 1000; i++) await grade(actor, cards[i % cards.length]!, (1 + (i % 4)) as 1 | 2 | 3 | 4, new Date(Date.UTC(2030, 0, 1) + i * 60_000));
result.review_grades_1000_ms = ms(t);
console.log(JSON.stringify(result));
process.exit(0);
