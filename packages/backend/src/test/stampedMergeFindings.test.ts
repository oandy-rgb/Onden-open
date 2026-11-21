// Findings in the REAL merge core (spine/stampedMerge/store.ts), from the planted-bug work (stampedMergePlanted.test.ts): a scenario the simulator does not have —
// a row made again over a permanent delete, with writes to fields the creation does not set (slug, published, trash) — breaks two README promises. Each is kept
// as `it.fails` naming the finding (a test that turns green the day the core is fixed, which is the signal to turn it into an ordinary test). Not fixed here:
// this batch changes no production code. The smallest cases are written out by hand; the simulator runs that found them are named with their seeds.
//
// Replaying the simulator runs: stampedMergePlanted.test.ts with STAMPED_PLANT_SEED=<seed − 1000>, test "the scenario this PR added …"; or the step lists below.
import { describe, expect, it } from "vitest";
import type { Step } from "./helpers/stampedSim/domain.js";
import { checkAgainstOracle, checkCausality, checkNoLoss } from "./helpers/stampedSim/runner.js";
import { checkAcrossDeletes, runAccounted } from "./helpers/stampedPlanted/checks.js";
import { type Cell, type Json, type Stamp } from "../spine/stampedMerge/unit.js";
import { type Store, STAR, addressKey, effectiveUnit, mergeStore, storeText } from "../spine/stampedMerge/store.js";

const T0 = 1_700_000_000_000;
const st = (origin: string, seq: number): Stamp => ({ origin, seq, wall: T0 + seq * 1000, counter: 0, author: origin, device: null });
const at = (field: string) => addressKey({ table: "note", row: "r", field });
const store = (...units: [string, Cell[]][]): Store => new Map(units);
const m = (a: Store, b: Store) => mergeStore(a, b).store;
const creation = (s: Stamp, seen: Record<string, number>, saw: Record<string, number> = {}): Cell => ({ stamp: s, saw, deleted: false, value: { title: "t" } as Json, meta: { seen } });

describe("FINDING 1: a write the deleter had NOT seen is dropped when the row is made again", () => {
  // README 「刪除之後再建立」: 「刪的人看過的欄位寫入不再是新值旁邊的頭；刪的人沒看過的寫入留下，成為衝突（它的作者看得到）」.
  // The delete's `meta.seen` is ONE number per device for the whole row (seenOfRow: the largest sequence number of that device's writes to ANY unit of the row), and
  // `droppedBySeen` drops every field write of that device up to that number. A deleter that got the device's later title edit but never its earlier slug edit (the
  // message was lost or late) "has seen" the slug edit by that number: the slug edit disappears on every node, with no conflict and no recovery copy (recoverLateEdits
  // uses the same number). README premise 「saw 只談自己這個單位」 is what the per-row number breaks; store.ts seenOfRow says "never for what is kept", droppedBySeen uses it for that.
  it.fails("smallest case: device n1 wrote the slug (#2) and then the title (#5); the deleter held only the title; the row is made again — the slug edit is still there", () => {
    const slug: Cell = { stamp: st("n1", 2), saw: {}, deleted: false, value: "my-page" };
    // the re-creation carries what the deleter had seen: n1 up to #5 (it held n1's title edit #5, not the slug edit #2)
    const remade = store([at(STAR), [creation(st("n2", 7), { n1: 5 })]]);
    const held = store([at("slug"), [slug]]);
    const after = m(held, remade);
    expect((effectiveUnit(after, { table: "note", row: "r", field: "slug" }) ?? []).map((c) => c.value)).toContain("my-page");
  });

  // Found by the simulator (seed 749887144 of the scenario, 102 steps, cut down to 12): n0's trash write is lost.
  const LOST: Step[] = [{ t: "op", node: 1, kind: "note.derived", p: [0.8224634963553399, 0.8340843201149255, 0.21482923766598105] }, { t: "op", node: 1, kind: "note.slug", p: [0.63070412655361, 0.009438013657927513, 0.31012874818407] }, { t: "deliver", n: 4 }, { t: "op", node: 0, kind: "note.trash", p: [0.8029891331680119, 0.47725486918352544, 0.8981841960921884] }, { t: "op", node: 0, kind: "note.slug", p: [0.989377134013921, 0.8551490767858922, 0.11900057247839868] }, { t: "op", node: 1, kind: "note.slug", p: [0.10738649824634194, 0.5507684526965022, 0.30705992970615625] }, { t: "op", node: 2, kind: "note.slug", p: [0.3965593222528696, 0.5427637707907706, 0.883819755865261] }, { t: "op", node: 2, kind: "note.trash", p: [0.45744607131928205, 0.48220893112011254, 0.07599572162143886] }, { t: "op", node: 1, kind: "note.slug", p: [0.5675970115698874, 0.439657311886549, 0.7128597276750952] }, { t: "deliver", n: 6 }, { t: "op", node: 1, kind: "note.purge", p: [0.3490727546159178, 0.4348028302192688, 0.8615508915390819] }, { t: "op", node: 1, kind: "note.derived", p: [0.8475654937792569, 0.7472083470784128, 0.8236029334366322] }];
  it.fails("the simulator's run (12 steps: n1 makes a note, edits; n0 trashes it and edits the slug; n1 deletes it for good and makes it again): nothing is lost", () => {
    expect(checkAcrossDeletes(runAccounted(749887144, LOST, { nodes: 4 }))).toEqual([]);
  });
});

describe("FINDING 2: what a re-creation drops depends on the order the writes arrive in", () => {
  // README 「一個單位怎麼合」: the state is a function of the SET of writes, so the merge is commutative, associative and idempotent and every node ends the same.
  // `mergeStore` drops the field writes a re-creation's `meta.seen` covers AT MERGE TIME, judged by the creations that are live then, and the dropped writes are not
  // kept anywhere. When a later permanent delete covers that re-creation, a node that had merged the re-creation first has lost the write; a node that got the delete
  // first keeps it. The simulator found it on this scenario as "merge is not associative" (seed 749887178, 92 steps) and "replaying the messages in another order
  // gives a different result" (seed 749887140, 47 steps); the three stores below are the smallest form.
  const write: Cell = { stamp: st("n1", 2), saw: {}, deleted: false, value: "my-page" };
  const a = store([at("slug"), [write]]);
  const b = store([at(STAR), [creation(st("n2", 5), { n1: 3 })]]); // made again by someone who held a delete that had seen n1 up to #3
  const c = store([at(STAR), [{ stamp: st("n3", 6), saw: { n2: 5 }, deleted: true, value: null, meta: { seen: {} } }]]); // deleted for good again, after seeing that re-creation
  it.fails("merge(merge(a, b), c) is merge(a, merge(b, c)): the same three sets of writes give the same store", () => {
    expect(storeText(m(m(a, b), c))).toBe(storeText(m(a, m(b, c))));
  });

  // The same mechanism, seen by the simulator's causality check (seed 910685724 of the scenario, cut down to 33 steps): node n0 wrote a slug after seeing n2's
  // slug (n0 #3 replaced n2 #4). A re-creation dropped n0's write at merge time; a later permanent delete covered that re-creation; n2's older slug, arriving
  // afterwards, was no longer dropped by anything. So the value a person had overwritten is a head again, and the write that replaced it is gone.
  const OVERWRITTEN_BACK: Step[] = [{"t": "op", "node": 1, "kind": "note.derived", "p": [0.11217190464958549, 0.10747992480173707, 0.3000775862019509]}, {"t": "op", "node": 2, "kind": "note.derived", "p": [0.2179661018308252, 0.5430372538976371, 0.4393829519394785]}, {"t": "op", "node": 2, "kind": "note.derived", "p": [0.6600916441529989, 0.7823962480761111, 0.9345643825363368]}, {"t": "op", "node": 2, "kind": "note.derived", "p": [0.13502616295590997, 0.38816570676863194, 0.09594578482210636]}, {"t": "op", "node": 2, "kind": "note.slug", "p": [0.5599008516874164, 0.3835236066952348, 0.5554692163132131]}, {"t": "gossip", "a": 2, "b": 0}, {"t": "op", "node": 3, "kind": "note.derived", "p": [0.36831636633723974, 0.8634030064567924, 0.8005855262745172]}, {"t": "op", "node": 3, "kind": "note.purge", "p": [0.37073344946838915, 0.15499963145703077, 0.7318484662100673]}, {"t": "op", "node": 0, "kind": "note.derived", "p": [0.8652846333570778, 0.803961711237207, 0.7595907533541322]}, {"t": "op", "node": 0, "kind": "note.purge", "p": [0.5414301373530179, 0.8839818388223648, 0.6434947992675006]}, {"t": "op", "node": 0, "kind": "note.slug", "p": [0.4084485243074596, 0.6035355438943952, 0.4469089412596077]}, {"t": "op", "node": 0, "kind": "note.purge", "p": [0.2611639820970595, 0.8201710050925612, 0.617297536926344]}, {"t": "op", "node": 0, "kind": "note.title", "p": [0.07956938352435827, 0.8208792216610163, 0.3311955912504345]}, {"t": "op", "node": 0, "kind": "note.purge", "p": [0.49193685222417116, 0.1675478289835155, 0.8843638754915446]}, {"t": "op", "node": 0, "kind": "note.derived", "p": [0.23393758828751743, 0.5816585107240826, 0.7317612080369145]}, {"t": "op", "node": 2, "kind": "note.derived", "p": [0.6839858228340745, 0.09395441971719265, 0.9383259590249509]}, {"t": "op", "node": 2, "kind": "note.trash", "p": [0.5315613597631454, 0.9630084722302854, 0.79265271499753]}, {"t": "op", "node": 0, "kind": "note.slug", "p": [0.09405715786851943, 0.4155761788133532, 0.611168236238882]}, {"t": "op", "node": 0, "kind": "note.publish", "p": [0.2954282558057457, 0.3303723172284663, 0.7949502649717033]}, {"t": "gossip", "a": 0, "b": 2}, {"t": "op", "node": 0, "kind": "note.title", "p": [0.8356436947360635, 0.9772863620892167, 0.70166140422225]}, {"t": "op", "node": 3, "kind": "note.derived", "p": [0.1990563205908984, 0.5271293434780091, 0.27032449445687234]}, {"t": "op", "node": 3, "kind": "note.purge", "p": [0.2834682937245816, 0.21545902406796813, 0.4414529555942863]}, {"t": "op", "node": 3, "kind": "note.purge", "p": [0.4382279103156179, 0.7261850438080728, 0.3954684832133353]}, {"t": "op", "node": 3, "kind": "note.slug", "p": [0.5352924612816423, 0.010315003339201212, 0.4192612343467772]}, {"t": "op", "node": 0, "kind": "note.purge", "p": [0.9066669901367277, 0.6604806261602789, 0.35769365984015167]}, {"t": "op", "node": 0, "kind": "note.purge", "p": [0.32705911924131215, 0.5587166708428413, 0.590165524976328]}, {"t": "op", "node": 0, "kind": "note.purge", "p": [0.1938074603676796, 0.6639956661965698, 0.05278619774617255]}, {"t": "op", "node": 1, "kind": "note.title", "p": [0.2545555606484413, 0.23736026068218052, 0.4829437844455242]}, {"t": "op", "node": 1, "kind": "note.derived", "p": [0.595842627575621, 0.08532894728705287, 0.5296046973671764]}, {"t": "op", "node": 1, "kind": "note.derived", "p": [0.04958443157374859, 0.931781645398587, 0.68317711353302]}, {"t": "op", "node": 0, "kind": "note.publish", "p": [0.5675369913224131, 0.49165689246729016, 0.9426301796920598]}, {"t": "op", "node": 0, "kind": "note.slug", "p": [0.23842000984586775, 0.12641583336517215, 0.8091520143207163]}];
  it.fails("the simulator's run (33 steps): a value someone overwrote after seeing it never comes back as a head (checkCausality)", () => {
    expect(checkCausality(runAccounted(910685724, OVERWRITTEN_BACK, { nodes: 4 }))).toEqual([]);
  });
});

describe("FINDING 3 (about a check, not the core): the simulator's checkNoLoss calls a write a permanent delete ended 'lost'", () => {
  // checkNoLoss (helpers/stampedSim/runner.ts) does not model the README rule that a field write the deleter had seen ends with the delete once the row is made again.
  // On the real code it fails for about 1 uniform seed in 45 (9 of 400 seeds measured); stampedMergeSim.test.ts runs seeds 1–5 only, which happen to pass, and with
  // fresh seeds every run (PR #1881) it would turn red now and then for this reason, not for a bug. Found on uniform seed 398846878 and cut down to five steps on ONE
  // node: it makes a note, makes it again, sets its slug, deletes it for good (having seen the slug) and makes it again. The README says the slug edit ends there.
  // The steps are written out (not drawn from the seed again), so a change to the step generator cannot make this pass by accident.
  const STEPS: Step[] = [{"t":"op","node":0,"kind":"note.derived","p":[0.3333333333333333,0,0]},{"t":"op","node":0,"kind":"note.derived","p":[0.6666666666666666,0,0]},{"t":"op","node":0,"kind":"note.slug","p":[0.5433371644467115,0.532374135684222,0.6205337338615209]},{"t":"op","node":0,"kind":"note.purge","p":[0.5208412322681397,0.6425401342567056,0.2689930440392345]},{"t":"op","node":0,"kind":"note.derived","p":[0.6597650705371052,0.9535356303676963,0.6958685258869082]}];
  const world = () => runAccounted(398846878, STEPS, { nodes: 4 });
  it("the oracle finds nothing wrong on these steps", () => { expect(checkAgainstOracle(world())).toEqual([]); });
  it("checkAcrossDeletes (which reads what each delete held from the log) finds nothing lost", () => { expect(checkAcrossDeletes(world())).toEqual([]); });
  it.fails("checkNoLoss holds on these steps", () => {
    expect(checkNoLoss(world())).toEqual([]); // fails: "(3) note.slug by n0 #3 is neither kept nor replaced by a write that saw it"
  });
});
