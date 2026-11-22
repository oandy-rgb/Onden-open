// A server copy never replaces a field this device has an edit of still waiting for its answer — for every kind of row,
// not only a note's own fields (storeOps.keepUnanswered). The REAL writers, write lifecycle and queue, and the REAL sync
// engine's doors (POST /api/sync → applyAndShow → storeOps; the ?nodes=none refresh and the whole bootstrap through
// takeBootstrap), against the fake server of helpers/fieldWorld.ts.
//
// Each kind: change once → answered → a sync is asked for → change again (no answer yet) → the sync's answer, which
// carries the first value, arrives → the second change is answered. After every step the store shows what the person
// did last.
//
// Then: the hold is not forever — another device's newer value that an answer carried while it was held shows once
// this device's write has its answer (the row is read again). And a random-order property over an attribute.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

const responses = vi.hoisted(() => ({ listener: null as null | ((path: string, init: RequestInit | undefined, response: Response) => void) }));
vi.mock("../lib/api", async (original) => ({
  ...await original<typeof import("../lib/api")>(),
  setWriteResponseListener: (listener: typeof responses.listener) => { responses.listener = listener; },
  api: vi.fn(async (path: string, init?: unknown) => {
    const { fieldWorld } = await import("./helpers/fieldWorld");
    return fieldWorld.transport(path, init as never);
  }),
}));
vi.mock("../lib/localDb", async () => {
  const { fieldWorld } = await import("./helpers/fieldWorld");
  return { ...fieldWorld.localDb };
});
vi.mock("../lib/fileSystemStorage", () => ({
  getStoragePref: vi.fn(() => "opfs"), getStoredDirHandle: vi.fn(async () => null), requestDirPermission: vi.fn(async () => false),
  readDbFromDir: vi.fn(async () => null), writeDbToDir: vi.fn(async () => {}),
}));

import { ApiError, type Bootstrap } from "../lib/api";
import type { AppliedSyncDelta } from "../lib/localDb";
import { ownerData } from "./ownerData";
import { getAppState, resetAppState, setData } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { _resetLocalCopyForTests } from "../lib/localCopyState";
import { dataSync, graphPositionWriter, propertyWriter, tagSchemaWriter, tagWriter, taskWriter, workspaceWriter } from "../lib/data";
import { __resetSyncEngineForTests, refreshMeta } from "../lib/data/syncEngine";
import { readAgain } from "../lib/data/serverTruthLoad";
import { forgetWatermark, startWatermarkFrom, syncPassEnded, takeAnswer } from "../lib/data/writePositions";
import { applySyncDelta, wholeBootstrapOver } from "../lib/data/storeOps";
import { stopWriteRetry } from "../lib/data/writeQueue";
import { fieldWorld as world, NOTE_ID, FIELD_SERVER_ID, TAG_ID, TASK_ID } from "./helpers/fieldWorld";

world.onResponse = (path, init, response) => responses.listener?.(path, init, response as unknown as Response);
world.makeApiError = (status) => new ApiError(status, JSON.stringify({ error: "x" }));
bindAccountStorage("u", "");

/** Let the writers' answer handling and the engine's awaits run (real timers: a pass has read deadlines). */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function open(): void {
  stopWriteRetry();
  world.reset();
  resetAppState({
    data: {
      ...ownerData, workspace: world.workspace(), nodes: [world.row(NOTE_ID), world.row(TAG_ID)], tasks: [...world.tasks.values()].map((t) => ({ ...t })),
      tags: world.tagCatalog(), graph_positions: [], last_event_id: String(world.head), bodies: "full",
    } as Bootstrap,
    online: true,
  });
  startWatermarkFrom({ position: String(world.head), server: FIELD_SERVER_ID });
}

beforeEach(async () => {
  await __resetSyncEngineForTests();
  readAgain.clear();
  forgetWatermark();
  syncPassEnded();
  _resetLocalCopyForTests();
  open();
});
afterEach(async () => {
  // Every answer held goes, every write still out ends (refused), until nothing is left: its journal entry and lane are
  // settled and no pass waits on it in the next test.
  world.holdAnswers = false;
  for (let round = 0; round < 20 && (world.held.length || world.inflight.length || world.unanswered.length); round++) {
    while (world.answer()) await settle();
    for (const respond of world.unanswered) respond();
    for (const request of world.inflight) world.refuse(request);
    await settle();
  }
  stopWriteRetry();
  await __resetSyncEngineForTests();
});

const data = () => getAppState().data;
const note = (id = NOTE_ID) => data().nodes.find((n) => n.id === id)!;
const quiet = (write: Promise<unknown>) => { write.catch(() => {}); };

type Answer = "sync" | "meta" | "whole";
type Kind = {
  name: string; first(): void; second(): void; shown(): unknown; firstValue: unknown; secondValue: unknown;
  /** The doors whose answers carry this kind of row. */
  answers: Answer[];
  /** Another device writes this row (the newer value it leaves). */
  remote(): unknown;
};

const KINDS: Kind[] = [
  {
    name: "an attribute (attribute:<note>)", answers: ["sync", "whole"],
    first: () => quiet(propertyWriter.set(NOTE_ID, "status", "one")), second: () => quiet(propertyWriter.set(NOTE_ID, "status", "two")),
    shown: () => note().attrs?.status, firstValue: "one", secondValue: "two",
    remote: () => { world.remote((w) => { w.notes.get(NOTE_ID)!.attrs.status = "other"; }); return "other"; },
  },
  {
    name: "a task (task:<task>)", answers: ["sync", "whole"],
    first: () => quiet(taskWriter.patch(TASK_ID, { status: "done" })), second: () => quiet(taskWriter.patch(TASK_ID, { title: "Do it now", status: "todo" })),
    shown: () => { const t = data().tasks.find((row) => row.id === TASK_ID)!; return `${t.status}/${t.title}`; },
    firstValue: "done/Do it", secondValue: "todo/Do it now",
    remote: () => { world.remote((w) => { w.tasks.set(TASK_ID, { ...w.tasks.get(TASK_ID)!, title: "Renamed elsewhere" }); }); return "todo/Renamed elsewhere"; },
  },
  {
    name: "a tag on a note (membership:<note>)", answers: ["sync", "whole"],
    first: () => quiet(tagWriter.apply(NOTE_ID, TAG_ID)), second: () => quiet(tagWriter.remove(NOTE_ID, TAG_ID)),
    shown: () => note().label_tag_ids?.includes(TAG_ID) ?? false, firstValue: true, secondValue: false,
    // Another device takes the tag off and puts it back: the server's answer still says "on", so the newer value here is
    // that it is on (this device's remove was applied before it).
    remote: () => { world.remote((w) => { w.notes.get(NOTE_ID)!.tags.push(TAG_ID); }); return true; },
  },
  {
    name: "a tag's hidden flag (node:<tag>, on the note row and in the tag list)", answers: ["sync", "meta", "whole"],
    first: () => quiet(tagWriter.setHidden(TAG_ID, true)), second: () => quiet(tagWriter.setHidden(TAG_ID, false)),
    shown: () => `${note(TAG_ID).hidden === true}/${data().tags?.find((t) => t.id === TAG_ID)?.hidden === true}`,
    firstValue: "true/true", secondValue: "false/false",
    remote: () => { world.remote((w) => { w.notes.get(TAG_ID)!.hidden = true; }); return "true/true"; },
  },
  {
    // A tag's fields are only in the tag list (no note row carries them): a sync answer, the ?nodes=none refresh and a
    // whole bootstrap all bring the list over the store's (storeOps.sharedRowsOver, the tag's row journal `node:<tag>`).
    name: "a tag's fields (node:<tag>, in the tag list)", answers: ["sync", "meta", "whole"],
    first: () => quiet(tagSchemaWriter.update(TAG_ID, { fields: [{ name: "Pages", type: "text" }] })),
    second: () => quiet(tagSchemaWriter.update(TAG_ID, { fields: [{ name: "Pages", type: "text" }, { name: "Author", type: "text" }] })),
    shown: () => ((data().tags?.find((t) => t.id === TAG_ID)?.schema_fields ?? []) as Array<{ name: string }>).map((f) => f.name).join("+"),
    firstValue: "Pages", secondValue: "Pages+Author",
    remote: () => { world.remote((w) => { w.notes.get(TAG_ID)!.fields = [{ name: "Elsewhere", type: "text" }]; }); return "Elsewhere"; },
  },
  {
    name: "the home page (workspace:<workspace>)", answers: ["sync", "meta", "whole"],
    first: () => quiet(workspaceWriter.setHome(NOTE_ID)), second: () => quiet(workspaceWriter.setHome(TAG_ID)),
    shown: () => data().workspace.home_node_id, firstValue: NOTE_ID, secondValue: TAG_ID,
    remote: () => { world.remote((w) => { w.home = null; }); return null; },
  },
  {
    name: "a graph position (position:<note>)", answers: ["meta", "whole"],
    first: () => quiet(graphPositionWriter.place(NOTE_ID, 1, 1)), second: () => quiet(graphPositionWriter.place(NOTE_ID, 2, 2)),
    shown: () => { const p = data().graph_positions?.find((row) => row.nodeId === NOTE_ID); return p ? `${p.x},${p.y}` : null; },
    firstValue: "1,1", secondValue: "2,2",
    remote: () => { world.remote((w) => { w.positions.set(NOTE_ID, { x: 9, y: 9 }); }); return "9,9"; },
  },
];

/** Ask through the door: the engine's own pass, refresh or whole refresh. */
function ask(answer: Answer): Promise<unknown> {
  if (answer === "sync") return dataSync.sync();
  if (answer === "meta") return refreshMeta().catch(() => null);
  return dataSync.refresh().catch(() => null);
}

describe("a server copy keeps every field whose edit has no answer yet", { timeout: 30_000 }, () => {
  for (const kind of KINDS) {
    for (const door of kind.answers) {
      it(`${kind.name}, through ${door}: the person's second change stays`, async () => {
        const seen: string[] = [];
        const check = (step: string) => { const v = kind.shown(); if (v !== kind.secondValue) seen.push(`${step}: shows ${JSON.stringify(v)}`); };
        kind.first(); await settle();
        world.deliver(world.inflight[0]); await settle();
        expect(kind.shown()).toEqual(kind.firstValue);
        world.holdAnswers = true;
        const pass = ask(door); await settle();
        expect(world.held.length).toBe(1); // read now: it carries the first value
        kind.second(); await settle();
        check("second change made");
        world.holdAnswers = false;
        world.answer(); await settle();
        check("the answer read before it arrived");
        world.deliver(world.inflight[0]); await settle();
        check("the second change answered");
        await pass; await settle();
        check("the pass ended");
        expect(seen).toEqual([]);
      });
    }
  }
});

describe("the hold is not forever: another device's newer value shows once this device's write has its answer", { timeout: 30_000 }, () => {
  for (const kind of KINDS) {
    const door = kind.answers[0]!;
    it(`${kind.name}, through ${door}`, async () => {
      kind.first(); await settle();
      world.deliver(world.inflight[0]); await settle();
      world.holdAnswers = true;
      const pass = ask(door); await settle(); // a pass sends the queue first: asked before the second change
      kind.second(); await settle();
      // The server applies the second change; its answer is still on its way. Then the other device writes, and the
      // answer is read after both and arrives while this device still waits: it carries the other device's newer value.
      const answerSecond = world.applyNow(world.inflight[0]);
      const newer = kind.remote();
      world.holdAnswers = false;
      world.answer(0, { readNow: true }); await settle();
      expect(kind.shown()).toEqual(kind.secondValue); // kept while unanswered
      answerSecond(); await settle(); await pass; await settle(); await settle();
      // Read again (GET /api/nodes/:id, or a bootstrap): the newer value, though no later answer carries that change.
      expect(kind.shown()).toEqual(newer);
    });
  }
});

// ── random order, one attribute ──
const RUNS = Number(process.env.PROPS_RUNS ?? 40);
const SEED = process.env.PROPS_SEED ? Number(process.env.PROPS_SEED) : Math.floor(Math.random() * 2 ** 31);
console.log(`[props] gateHoldsEveryUnansweredEdit seed=${SEED} runs=${RUNS} (replay: PROPS_SEED=${SEED} PROPS_RUNS=${RUNS})`);

type Captured = { head: number; delta?: ReturnType<typeof world.delta>; whole?: Bootstrap };

/** An answer read at `head` reaches the store through the page's door, as syncEngine.applyAndShow / setWholeBootstrap do. */
async function arrive(answer: Captured): Promise<void> {
  if (answer.delta) {
    const delta = structuredClone(answer.delta) as unknown as AppliedSyncDelta;
    await takeAnswer({ head: delta.head_event_id, serverId: FIELD_SERVER_ID, toCopy: async () => ({ value: delta }), toStore: (taken) => setData((d) => applySyncDelta(d, taken)) });
  } else {
    const whole = structuredClone(answer.whole!);
    await takeAnswer({ head: whole.last_event_id, serverId: FIELD_SERVER_ID, wholeState: true, toCopy: async () => ({ value: whole }), toStore: (taken) => setData((d) => wholeBootstrapOver(d, taken).state) });
  }
  await settle();
}

describe("random order: changes, answers, late and repeated sync answers, whole bootstraps (one attribute)", { timeout: 120_000 }, () => {
  it("the store always shows the person's last value", async () => {
    const step = fc.oneof(
      fc.constant({ op: "edit" as const, n: 0 }), fc.constant({ op: "deliver" as const, n: 0 }),
      fc.record({ op: fc.constant("ask" as const), n: fc.nat(1) }), fc.record({ op: fc.constant("answer" as const), n: fc.nat(5) }),
      fc.record({ op: fc.constant("answerAgain" as const), n: fc.nat(5) }),
    );
    await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 24 }), async (steps) => {
      for (const request of world.inflight) world.refuse(request);
      await settle();
      readAgain.clear(); forgetWatermark(); open();
      const answers: Captured[] = [];
      let last: string | undefined;
      let edits = 0;
      const problems: string[] = [];
      const check = (label: string) => {
        const shown = note().attrs?.status;
        if (last !== undefined && shown !== last) problems.push(`after ${label}: shows ${shown}, the person's last value is ${last}`);
      };
      for (const { op, n } of steps) {
        if (op === "edit") { last = `v${++edits}`; quiet(propertyWriter.set(NOTE_ID, "status", last)); await settle(); }
        else if (op === "deliver") { world.deliver(world.inflight[0]); await settle(); } // one lane per note: one write out at a time
        else if (op === "ask") answers.push(n ? { head: world.head, whole: world.bootstrap(false) } : { head: world.head, delta: world.delta(0) });
        else if (answers.length) {
          const at = n % answers.length;
          const answer = answers[at]!;
          if (op === "answer") answers.splice(at, 1);
          await arrive(answer);
        }
        check(`${op} ${n}`);
      }
      while (world.inflight.length) { world.deliver(world.inflight[0]); await settle(); }
      await arrive({ head: world.head, delta: world.delta(0) });
      check("everything answered and a fresh answer");
      expect(problems).toEqual([]);
    }), { seed: SEED, numRuns: RUNS });
  });
});

// The writers that now keep a journal (setHidden, tagSchemaWriter, graphPositionWriter) and the one whose journal changed shape
// (tagWriter's membership, one journal per note): a refusal still puts back what was there, and two refused in a row put
// back the value before both, not the first refused one (optimisticFields).
describe("a refusal puts back what was there before (journals added or reshaped here)", { timeout: 30_000 }, () => {
  for (const kind of KINDS.filter((k) => /tag|position/.test(k.name))) {
    it(`${kind.name}: one refused, then two refused in a row`, async () => {
      const start = kind.shown();
      kind.first(); await settle();
      world.refuse(world.inflight[0]); await settle();
      expect(kind.shown()).toEqual(start);
      kind.first(); await settle();
      kind.second(); await settle();
      world.refuse(world.inflight[0]); await settle();
      expect(kind.shown()).toEqual(kind.secondValue); // the later change stays while the earlier one is refused
      world.refuse(world.inflight[0]); await settle();
      expect(kind.shown()).toEqual(start);
    });
  }
});
