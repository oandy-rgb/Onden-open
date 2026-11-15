// Two devices, one account, random interleavings of the settings that follow
// the account: lib/syncedPrefStore (the store), lib/accountPrefStore (legacy
// move + "only moves forward"), and the real prefs built on them:
//   rssFeedCounts   plain key: the last edit stands; has a this-device legacy value
//   rssLastVisit    `isNewer` key (a time); has a legacy value
//   dayNoteParent   plain key, no legacy (lib/data/dayNoteParentStore)
//
// A device is a localStorage (its local copy) plus the page's memory. The
// memory is rebuilt from the local copy whenever the test switches device or
// reloads (`forget()` then mount, like a fresh page), so only what the local
// copy keeps can carry over, which is what "reload" must prove. The server is a
// map that answers or fails per step: "ok", "down" (request never arrives),
// "lost" (the server applies it, the response is lost).
//
// Steps: edit (save), sync (focus/online), reload, switch device, each with the
// network mode of that step. Old this-device values ("legacy") are seeded
// before a device's first page load.
//
// Invariants:
//   converge   after both devices go online and sync, device 0, device 1 and
//              the server hold the same value for every key, nothing dirty
//   keep       a local edit the server has not acknowledged is still on the
//              device (value and dirty) after any later step or reload
//   forward    isNewer keys: the server's value never becomes older (it may be
//              reset to nothing by an explicit save(null), not by a sync)
//   legacy     an old this-device value reaches the server only when the
//              server holds nothing (or, for isNewer keys, something older);
//              afterwards the old copy is gone from the device
//   last       with every request succeeding, the key ends as the last edit in
//              time (plain keys) / the newest value (isNewer keys)
//
//   later      dayNoteParent (no legacy value): after everything is delivered
//              the server holds the edit that was made last in time, whichever
//              device made it and however long it stayed offline
//
// Two cases that used to be it.fails findings are now plain tests at the end:
// an older offline edit no longer overwrites a newer one from the other device
// (the server keeps the later edit: PUT carries `editAgeMs`), and an isNewer
// key no longer goes back when another device writes between this device's
// read and write (there is no read: the server compares in one statement).
// The fake server below mirrors services/actorPrefs.ts writePref.
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/accountPrefs

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { act, renderHook } from "@testing-library/react";

type Net = "ok" | "down" | "lost";
const world = vi.hoisted(() => ({
  server: new Map<string, unknown>(),
  net: "ok" as "ok" | "down" | "lost",
  device: 0,
  writes: [] as { device: number; key: string; value: unknown; before: unknown }[],
  acked: [] as { device: number; key: string; value: unknown }[],
  /** The edit time stored per key (the server keeps the later edit). */
  editedAt: new Map<string, number>(),
  /** The test clock: every read of Date.now() is later than the one before, across both devices. */
  tick: 0,
  /** Called with the answer of a read before it returns; lets a test hold it. */
  readGate: null as null | ((answer: unknown) => Promise<void>),
  /** Called before a write is applied; lets a test hold it in flight. */
  writeGate: null as null | (() => Promise<void>),
}));
/** The order of a "moves forward" key, as services/actorPrefs.ts FORWARD_ORDER. */
const FORWARD: Record<string, (value: unknown) => number> = {
  rssLastVisit: (v) => Date.parse(v as string),
};
vi.mock("../../lib/data/onlineWrite", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/data/onlineWrite")>(),
  sendWrite: vi.fn(async (_method: string, path: string, body: { value: unknown; editAgeMs?: number }) => {
    // the route dates the edit by the server's clock: now - age
    const editedAt = body.editAgeMs === undefined ? undefined : Date.now() - body.editAgeMs;
    if (world.net === "down") throw new Error("offline");
    if (world.writeGate) await world.writeGate();
    const key = path.split("/").pop()!;
    const current = world.server.get(key) ?? null;
    const order = FORWARD[key];
    const stored = world.editedAt.get(key);
    // one atomic step, like the single INSERT … ON CONFLICT … WHERE statement
    const applied = editedAt === undefined
      || (body.value !== null && order ? current === null || order(current) <= order(body.value) : stored === undefined || stored <= editedAt);
    if (applied) {
      world.writes.push({ device: world.device, key, value: body.value, before: current });
      if (body.value === null && editedAt === undefined) { world.server.delete(key); world.editedAt.delete(key); }
      else {
        world.server.set(key, body.value);
        if (editedAt !== undefined) world.editedAt.set(key, Math.max(stored ?? 0, editedAt));
      }
    }
    if (world.net === "lost") throw new Error("response lost");
    world.acked.push({ device: world.device, key, value: body.value });
    return { value: applied ? body.value : current, applied };
  }),
}));
vi.mock("../../lib/data/reads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/data/reads")>();
  return {
    ...real,
    reads: {
      ...real.reads,
      people: {
        ...real.reads.people,
        myPref: vi.fn(async (key: string) => {
          if (world.net === "down") throw new Error("offline");
          const answer = { value: world.server.get(key) ?? null };
          if (world.readGate) await world.readGate(answer);
          if (world.net === "lost") throw new Error("response lost");
          return answer;
        }),
      },
    },
  };
});

import { rssFeedCountsPref, rssLastVisitPref } from "../../modules/rss/rssPrefs";
import { dayNoteParentPref } from "../../lib/data/dayNoteParentStore";
import type { SyncedPrefStore } from "../../lib/syncedPrefStore";
import { bindAccountStorage } from "../../lib/accountStorage";
import { PREFS, getPrefJson, prefKey, type Pref } from "../../lib/prefs";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

// each run mounts pages and walks a fake network: a short default, PROPS_RUNS raises it
/** A raised PROPS_RUNS makes a property run for minutes: no 5 s test timeout (a timed-out run would keep going and corrupt the next test). */
const LONG = 600_000;
const cfg = { numRuns: process.env.PROPS_RUNS ? PROPS_RUNS : 40, seed: PROPS_SEED };

// ── keys ────────────────────────────────────────────────────────────────────

type KeyName = "feeds" | "visit" | "dayParent";
const KEYS: KeyName[] = ["feeds", "visit", "dayParent"];
type Spec = {
  serverKey: string;
  store: SyncedPrefStore<unknown>;
  forward: boolean;
  legacyPref: Pref | null;
  copy: Pref;
  /** Edit values, oldest to newest for `forward` keys; index picks one. */
  edit: (i: number) => unknown;
  legacy: (i: number) => { raw: string; value: unknown };
};
const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (n: number) => new Date(T0 + n * DAY).toISOString();
const asStore = (store: unknown) => store as SyncedPrefStore<unknown>;
const SPEC: Record<KeyName, Spec> = {
  feeds: {
    serverKey: "rssFeedCounts", copy: PREFS.rssFeedCountsCopy, store: asStore(rssFeedCountsPref.store), forward: false, legacyPref: PREFS.rssFeedCounts,
    edit: (i) => ({ [`e${i}`]: "on" }),
    legacy: (i) => ({ raw: JSON.stringify({ [`old${i}`]: "on" }), value: { [`old${i}`]: "on" } }),
  },
  visit: {
    serverKey: "rssLastVisit", copy: PREFS.rssLastVisitCopy, store: asStore(rssLastVisitPref.store), forward: true, legacyPref: PREFS.rssLastVisit,
    // edits are on whole days, legacy values half a day after one, so they never collide
    edit: (i) => iso(i),
    legacy: (i) => ({ raw: new Date(T0 + (i + 0.5) * DAY).toISOString(), value: new Date(T0 + (i + 0.5) * DAY).toISOString() }),
  },
  dayParent: {
    serverKey: "dayNoteParent", copy: PREFS.dayNoteParentCopy, store: asStore(dayNoteParentPref.store), forward: false, legacyPref: PREFS.dayNoteParent,
    edit: (i) => `note-${i}`,
    legacy: (i) => ({ raw: `old-note-${i}`, value: `old-note-${i}` }),
  },
};
const NEWER: Record<string, (a: unknown, b: unknown) => boolean> = {
  rssLastVisit: (a, b) => Date.parse(a as string) > Date.parse(b as string),
};
/** Total order of an isNewer key's values; the position of `v` in time. */
const rank = (key: KeyName, v: unknown): number => Date.parse(v as string);

// ── devices ─────────────────────────────────────────────────────────────────

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

type Device = { storage: Storage; mounted: ReturnType<typeof renderHook> | null };

function Pages() {
  // what the pages of the app mount: RSS (feeds, visit), the day-note setting
  dayNoteParentPref.useKeepInSync();
  rssFeedCountsPref.useKeepInSync();
  rssLastVisitPref.useKeepInSync();
  return null;
}

const devices: Device[] = [];
function fresh(legacy: Partial<Record<KeyName, number>>): void {
  world.server.clear(); world.editedAt.clear(); world.writes = []; world.acked = []; world.net = "ok"; world.readGate = null; world.writeGate = null;
  devices.length = 0;
  for (let d = 0; d < 2; d++) {
    const storage = memoryStorage();
    devices.push({ storage, mounted: null });
    vi.stubGlobal("localStorage", storage);
    bindAccountStorage("props-account", "");
    for (const key of KEYS) {
      const seed = legacy[key];
      const spec = SPEC[key];
      if (seed !== undefined && spec.legacyPref) storage.setItem(prefKey(spec.legacyPref)!, spec.legacy(seed + d * 10).raw);
    }
  }
}

async function unmount(d: Device): Promise<void> {
  if (!d.mounted) return;
  const m = d.mounted;
  d.mounted = null;
  m.unmount();
}
let active = -1;
/** Make device `n` the page on screen: a fresh page over its local copy. */
async function open(n: number, net: Net): Promise<void> {
  if (active >= 0) await unmount(devices[active]);
  active = n;
  world.device = n;
  world.net = net;
  vi.stubGlobal("localStorage", devices[n].storage);
  for (const key of KEYS) SPEC[key].store.forget();
  devices[n].mounted = renderHook(() => Pages());
  await settle();
}
// the fake network answers in microtasks: a few turns let every chained sync finish
const settle = async () => { await act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); }); };

type Step =
  | { kind: "edit"; device: number; key: KeyName; i: number; net: Net }
  | { kind: "clear"; device: number; key: KeyName; net: Net }
  | { kind: "sync"; device: number; net: Net }
  | { kind: "reload"; device: number; net: Net };

const netArb = fc.constantFrom<Net>("ok", "ok", "down", "lost");
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("edit" as const), device: fc.nat(1), key: fc.constantFrom(...KEYS), i: fc.integer({ min: 1, max: 8 }), net: netArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("clear" as const), device: fc.nat(1), key: fc.constantFrom<KeyName>("feeds", "dayParent"), net: netArb }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("sync" as const), device: fc.nat(1), net: netArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("reload" as const), device: fc.nat(1), net: netArb }) },
);

const legacyArb = fc.record({
  feeds: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
  visit: fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined }),
}) as fc.Arbitrary<Partial<Record<KeyName, number>>>;

const valueOf = (key: KeyName) => SPEC[key].store.get();

/** Run one step; returns the edit it made, if any. */
async function run(step: Step): Promise<void> {
  await open(step.device, step.net);
  if (step.kind === "edit") {
    await act(async () => { SPEC[step.key].store.save(SPEC[step.key].edit(step.i) as never); await SPEC[step.key].store.sync(); });
  } else if (step.kind === "clear") {
    await act(async () => { SPEC[step.key].store.save(null); await SPEC[step.key].store.sync(); });
  } else if (step.kind === "sync") {
    await act(async () => { for (const key of KEYS) await SPEC[key].store.sync(); });
  }
  await settle();
}

async function allOnlineAndSynced(): Promise<void> {
  for (const n of [0, 1, 0, 1, 0]) {
    await open(n, "ok");
    await act(async () => { for (const key of KEYS) await SPEC[key].store.sync(); });
    await settle();
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  active = -1;
  world.tick = 0;
  vi.spyOn(Date, "now").mockImplementation(() => T0 + 400 * DAY + ++world.tick);
});
afterEach(async () => {
  if (active >= 0) await unmount(devices[active]);
  active = -1;
  world.readGate = null; world.writeGate = null;
  vi.unstubAllGlobals();
  vi.mocked(Date.now).mockRestore();
});

// ── the invariants ──────────────────────────────────────────────────────────

/** Unsent edits per device and key: set by an edit, cleared once that device's write was acknowledged. */
describe("settings that follow the account", () => {
  it("converge, keep, forward, legacy: random interleavings of two devices", async () => {
    await fc.assert(fc.asyncProperty(legacyArb, fc.array(stepArb, { minLength: 1, maxLength: 14 }), async (legacy, steps) => {
      fresh(legacy);
      const pending = new Map<string, { value: unknown }>();
      const lastForward = new Map<string, number>();
      const legacyValues = new Map<string, Set<string>>();
      for (let d = 0; d < 2; d++) for (const key of KEYS) {
        const spec = SPEC[key];
        if (legacy[key as "feeds"] !== undefined && spec.legacyPref) {
          const set = legacyValues.get(spec.serverKey) ?? new Set<string>();
          set.add(JSON.stringify(spec.legacy((legacy[key as "feeds"] as number) + d * 10).value));
          legacyValues.set(spec.serverKey, set);
        }
      }
      let ackedCount = 0;
      for (const step of steps) {
        await run(step);
        if (step.kind === "edit") pending.set(`${step.device}/${step.key}`, { value: SPEC[step.key].edit(step.i) });
        if (step.kind === "clear") pending.set(`${step.device}/${step.key}`, { value: null });
        // acknowledged writes retire this device's pending edit for the key
        for (const ack of world.acked.slice(ackedCount)) {
          const key = KEYS.find((k) => SPEC[k].serverKey === ack.key)!;
          pending.delete(`${ack.device}/${key}`);
        }
        ackedCount = world.acked.length;
        // keep: what is still unsent is still on the device that made it
        for (const [id, edit] of pending) {
          const [device, key] = [Number(id.split("/")[0]), id.split("/")[1] as KeyName];
          // read the device's local copy itself: that is all a reload would have
          vi.stubGlobal("localStorage", devices[device].storage);
          const held = getPrefJson(SPEC[key].copy) as { value: unknown; dirty: boolean } | null;
          expect(held?.dirty, `${id} dirty after ${JSON.stringify(step)}`).toBe(true);
          expect(held?.value ?? null, `${id} value after ${JSON.stringify(step)}`).toEqual(edit.value);
        }
        // forward: isNewer keys on the server never get older
        for (const key of KEYS) {
          const spec = SPEC[key];
          if (!spec.forward) continue;
          const now = world.server.get(spec.serverKey);
          if (now == null) { lastForward.delete(key); continue; }
          const was = lastForward.get(key);
          if (was !== undefined) expect(rank(key, now), `server ${key} went back after ${JSON.stringify(step)}`).toBeGreaterThanOrEqual(was);
          lastForward.set(key, rank(key, now));
        }
      }
      // legacy: a write of an old this-device value only over nothing / something older
      for (const w of world.writes) {
        const values = legacyValues.get(w.key);
        if (!values?.has(JSON.stringify(w.value))) continue;
        const newer = NEWER[w.key];
        if (w.before === null || w.before === undefined) continue;
        // a device with an older edit puts the server's own newer value back: no change
        if (JSON.stringify(w.before) === JSON.stringify(w.value)) continue;
        expect(newer && newer(w.value, w.before), `legacy ${JSON.stringify(w.value)} overwrote ${JSON.stringify(w.before)} on ${w.key}`).toBe(true);
      }
      await allOnlineAndSynced();
      // later: the last edit (or reset) of the day-note parent in time is what the account holds
      const lastDay = [...steps].reverse().find((s) => s.kind !== "sync" && s.kind !== "reload" && s.key === "dayParent") as Extract<Step, { key: KeyName }> | undefined;
      if (lastDay) expect(world.server.get("dayNoteParent") ?? null, "dayNoteParent is the last edit in time").toEqual(lastDay.kind === "edit" ? SPEC.dayParent.edit(lastDay.i) : null);
      for (const key of KEYS) {
        const spec = SPEC[key];
        const onServer = world.server.get(spec.serverKey) ?? null;
        for (const n of [0, 1]) {
          await open(n, "down");
          const held = valueOf(key);
          expect(held.dirty, `${key} on device ${n} still dirty`).toBe(false);
          expect(held.value, `${key} on device ${n}`).toEqual(onServer);
        }
        // the old copy is gone from both devices once the account holds its answer
        if (spec.legacyPref) for (const d of devices) expect(d.storage.getItem(prefKey(spec.legacyPref)!), `${key} legacy copy left behind`).toBeNull();
      }
      await unmount(devices[active]); active = -1;
    }), cfg);
  }, LONG);

  it("last: when every request succeeds, the key ends as the last edit (plain) or the newest value (isNewer)", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({
      device: fc.nat(1), key: fc.constantFrom(...KEYS), i: fc.integer({ min: 1, max: 8 }), then: fc.constantFrom("edit", "edit", "reload", "sync"),
    }), { minLength: 1, maxLength: 12 }), async (steps) => {
      fresh({});
      const last = new Map<KeyName, number>();
      const newest = new Map<KeyName, number>();
      for (const s of steps) {
        await run({ kind: s.then === "edit" ? "edit" : s.then, device: s.device, key: s.key, i: s.i, net: "ok" } as Step);
        if (s.then === "edit") { last.set(s.key, s.i); newest.set(s.key, Math.max(newest.get(s.key) ?? 0, s.i)); }
      }
      await allOnlineAndSynced();
      for (const key of KEYS) {
        const i = SPEC[key].forward ? newest.get(key) : last.get(key);
        expect(world.server.get(SPEC[key].serverKey) ?? null, key).toEqual(i === undefined ? null : SPEC[key].edit(i));
      }
      await unmount(devices[active]); active = -1;
    }), cfg);
  }, LONG);

  it("an edit made while an earlier one is in flight is not lost, and is sent next", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(...KEYS), fc.integer({ min: 1, max: 3 }), fc.integer({ min: 4, max: 8 }), fc.boolean(), async (key, first, second, reload) => {
      fresh({});
      await open(0, "ok");
      let release!: () => void;
      world.writeGate = () => new Promise<void>((resolve) => { release = resolve; });
      let syncing!: Promise<void>;
      await act(async () => { SPEC[key].store.save(SPEC[key].edit(first) as never); syncing = SPEC[key].store.sync(); });
      world.writeGate = null;
      await act(async () => { SPEC[key].store.save(SPEC[key].edit(second) as never); });
      if (reload) { /* the page is gone while the first is still out: only the local copy is left */
        vi.stubGlobal("localStorage", devices[0].storage);
        const held = getPrefJson(SPEC[key].copy) as { value: unknown; dirty: boolean };
        expect(held).toMatchObject({ value: SPEC[key].edit(second), dirty: true });
      }
      await act(async () => { release(); await syncing; });
      await settle();
      expect(world.server.get(SPEC[key].serverKey)).toEqual(SPEC[key].edit(second));
      expect(SPEC[key].store.get()).toMatchObject({ value: SPEC[key].edit(second), dirty: false });
      await unmount(devices[active]); active = -1;
    }), { ...cfg, numRuns: Math.min(cfg.numRuns, 20) });
  }, LONG);

  // ── the two races that used to be findings ──────────────────────────────

  it("an older offline edit does not overwrite a newer edit from the other device", async () => {
    fresh({});
    await run({ kind: "edit", device: 0, key: "dayParent", i: 1, net: "down" }); // phone, offline, first
    await run({ kind: "edit", device: 1, key: "dayParent", i: 2, net: "ok" });   // laptop, later, online
    await allOnlineAndSynced();                                                  // phone reconnects
    expect(world.server.get("dayNoteParent")).toBe("note-2");                    // the later edit stands
    for (const n of [0, 1]) { await open(n, "down"); expect(valueOf("dayParent")).toMatchObject({ value: "note-2", dirty: false }); }
    await unmount(devices[active]); active = -1;
  });

  it("an isNewer key does not go back when another device writes while this device's write is in flight", async () => {
    fresh({});
    await run({ kind: "edit", device: 0, key: "visit", i: 1, net: "ok" });
    await open(1, "ok");
    // device 1 sends day 3 and the request is slow ...
    let release!: () => void;
    world.writeGate = () => new Promise<void>((resolve) => { release = resolve; });
    let syncing!: Promise<void>;
    await act(async () => { SPEC.visit.store.save(SPEC.visit.edit(3) as never); syncing = SPEC.visit.store.sync(); });
    world.writeGate = null;
    // ... meanwhile device 0 records a later visit (day 7)
    world.server.set("rssLastVisit", iso(7));
    await act(async () => { release(); await syncing; });
    await settle();
    expect(world.server.get("rssLastVisit")).toBe(iso(7));
    expect(valueOf("visit")).toMatchObject({ value: iso(7), dirty: false });
    await unmount(devices[active]); active = -1;
  });
});
