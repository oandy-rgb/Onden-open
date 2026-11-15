// Pure protocol tests: stable pages + hydration, bounded retries and partial
// application. The PG suite membershipProtocol.integration.test.ts also runs
// this real client orchestrator against the actual routes.

import { describe, it, expect, vi } from "vitest";
import { reconcileMembership, type MembershipDigest, type MembershipPage, type MembershipProjection, type ReconcileDeps } from "../lib/data/membershipReconcile";
import { createHash } from "node:crypto";
import { membershipDigestOf, webCryptoSha256 } from "../lib/data/membershipDigest";

// Build a fake server: a sequence of "epoch states", each a sorted id list.
// fetchPage serves keyset pages of the CURRENT state and stamps the current
// epoch; if `expected` ≠ current it returns an empty page carrying current
// (the real endpoint's torn-read / stale-expected signal).
function fakeServer(states: Array<{ epoch: number; ids: string[] }>, pageSize = 2) {
  let idx = 0; // which state is "current" — advance via .advance()
  const fetchPage = vi.fn(async (cursor: string, expected: number): Promise<MembershipPage> => {
    const cur = states[idx]!;
    if (cur.epoch !== expected) return { ids: [], next_cursor: null, epoch: cur.epoch, event_cursor: String(idx + 100) };
    const sorted = [...cur.ids].sort();
    const start = cursor ? sorted.findIndex((id) => id > cursor) : 0;
    const slice = start < 0 ? [] : sorted.slice(start, start + pageSize);
    const next = slice.length === pageSize ? slice[slice.length - 1]! : null;
    return { ids: slice, next_cursor: next, epoch: cur.epoch, event_cursor: String(idx + 100) };
  });
  return { fetchPage, advance: () => { idx = Math.min(idx + 1, states.length - 1); }, callCount: () => fetchPage.mock.calls.length };
}

function projection(ids: string[], epoch: number, event_cursor: string): MembershipProjection {
  return { epoch, event_cursor, nodes: ids.map(id => ({ id })) as MembershipProjection["nodes"],
    attributes: { upsert: [], delete: [] }, edges: [], tasks: [] };
}

function deps(over: Partial<ReconcileDeps> & Pick<ReconcileDeps, "startEpoch" | "fetchPage">): ReconcileDeps {
  return {
    getLocalKnown: async () => [],
    isolateRevoked: vi.fn(async () => {}),
    fetchProjection: vi.fn(async (ids, epoch) => projection(ids, epoch, "100")),
    applyProjection: vi.fn(async () => {}),
    saveEpoch: vi.fn(async () => {}),
    ...over,
  };
}

describe("reconcileMembership — happy path", () => {
  it("replaces the catalog even with no node grants, then confirms the snapshot before saving epoch", async () => {
    const order: string[] = [];
    const applyProjection = vi.fn(async (value: MembershipProjection) => {
      order.push("catalog");
      expect(value.tags).toEqual([]);
    });
    const fetchPage = vi.fn(async (cursor: string): Promise<MembershipPage> => {
      if (cursor) order.push("confirm");
      return { ids: [], next_cursor: null, epoch: 3, event_cursor: "100", ...(cursor ? {} : { tags: [] }) };
    });
    const result = await reconcileMembership(deps({ startEpoch: 3, fetchPage, applyProjection,
      saveEpoch: async () => { order.push("save"); },
    }));
    expect(result.status).toBe("done");
    expect(order).toEqual(["catalog", "confirm", "save"]);
    expect(applyProjection).toHaveBeenCalledTimes(1);
  });
  it("drains all pages, diffs vs local, isolates revoked then applies grants, saves epoch LAST", async () => {
    const srv = fakeServer([{ epoch: 7, ids: ["a", "b", "c", "d", "e"] }]);
    const order: string[] = [];
    const isolateRevoked = vi.fn(async () => { order.push("revoke"); });
    const applyProjection = vi.fn(async () => { order.push("grant"); });
    const saveEpoch = vi.fn(async () => { order.push("save"); });
    const d = deps({
      startEpoch: 7,
      fetchPage: srv.fetchPage,
      getLocalKnown: async () => ["b", "x", "y"], // x,y revoked; a,c,d,e granted
      isolateRevoked, applyProjection, saveEpoch,
    });
    const res = await reconcileMembership(d);
    expect(res).toMatchObject({ status: "done", epoch: 7, revoked: 2, granted: 4 });
    expect(isolateRevoked).toHaveBeenCalledWith(expect.arrayContaining(["x", "y"]));
    expect(applyProjection).toHaveBeenCalledWith(expect.objectContaining({ nodes: ["a", "c", "d", "e"].map(id => ({ id })) }));
    // Ordering is load-bearing: revoke → grant → save (save is LAST).
    expect(order).toEqual(["revoke", "grant", "save"]);
  });
});

describe("membership snapshot across pages and hydration", () => {
  it("creation behind the page cursor at the same epoch never deletes the new local node (events bring the rest)", async () => {
    const srv = fakeServer([
      { epoch: 7, ids: ["a", "c", "e"] },
      { epoch: 7, ids: ["a", "b", "c", "e"] },
    ]);
    const local = new Set(["a", "c", "e"]);
    let pages = 0;
    const fetchPage = vi.fn(async (cursor: string, expected: number) => {
      if (++pages === 2) { srv.advance(); local.add("b"); }
      return srv.fetchPage(cursor, expected);
    });
    const isolated: string[] = [];
    const result = await reconcileMembership(deps({ startEpoch: 7, fetchPage,
      getLocalKnown: async () => [...local],
      isolateRevoked: async revoked => { isolated.push(...revoked); },
    }));
    expect(result.status).toBe("done");
    expect(isolated).not.toContain("b");
    expect(pages).toBeLessThanOrEqual(3); // only the epoch is pinned: no restart for a same-epoch event
  });

  it("deletion after an earlier page at the same epoch is left to the event scan from the first read's position", async () => {
    const srv = fakeServer([
      { epoch: 7, ids: ["a", "b", "c"] },
      { epoch: 7, ids: ["b", "c"] },
    ]);
    let pages = 0;
    const isolateRevoked = vi.fn(async () => {});
    const result = await reconcileMembership(deps({ startEpoch: 7,
      fetchPage: async (cursor, expected) => {
        if (++pages === 2) srv.advance();
        return srv.fetchPage(cursor, expected);
      },
      getLocalKnown: async () => ["a", "b", "c"], isolateRevoked,
    }));
    // The deletion is an event after the first read, not a permission change
    // (that would move the epoch): sync scans events from this position on.
    expect(result).toMatchObject({ status: "done", eventCursor: "100" });
    expect(isolateRevoked).toHaveBeenCalledWith([]);
  });
});

describe("reconcileMembership — failure recovery (the three classes)", () => {
  it("1. epoch changes MID-pagination → discard + restart (no apply/save on the aborted attempt)", async () => {
    // State 7 has 5 ids (3 pages at size 2). After page 1, a permission change
    // flips current → epoch 8. Page 2 (expected 7) returns current epoch 8 → miss.
    const srv = fakeServer([
      { epoch: 7, ids: ["a", "b", "c", "d", "e"] },
      { epoch: 8, ids: ["a", "b", "c", "d", "e"] },
    ]);
    const isolateRevoked = vi.fn(async () => {});
    const applyProjection = vi.fn(async () => {});
    const saveEpoch = vi.fn(async () => {});
    let page = 0;
    const fetchPage = vi.fn(async (cursor: string, expected: number) => {
      page++;
      if (page === 2) srv.advance(); // permission change lands between page 1 and 2
      return srv.fetchPage(cursor, expected);
    });
    const d = deps({ startEpoch: 7, fetchPage, getLocalKnown: async () => [], isolateRevoked, applyProjection, saveEpoch });
    const res = await reconcileMembership(d);
    // It restarts at epoch 8 and completes there.
    expect(res).toMatchObject({ status: "done", epoch: 8 });
    // The aborted (epoch-7) attempt applied/saved NOTHING; only the stable epoch-8
    // pass did. saveEpoch was called exactly once, with 8 — never with 7.
    expect(saveEpoch).toHaveBeenCalledTimes(1);
    expect(saveEpoch).toHaveBeenCalledWith(8);
  });

  it("2. epoch changes AFTER the last page → final re-confirm rejects → restart", async () => {
    // One page (≤2 ids) so the loop ends immediately; the change lands on the
    // FINAL re-confirm probe, not during paging.
    const srv = fakeServer([
      { epoch: 7, ids: ["a", "b"] },
      { epoch: 9, ids: ["a", "b"] },
    ], 3);
    let calls = 0;
    const saveEpoch = vi.fn(async () => {});
    const fetchPage = vi.fn(async (cursor: string, expected: number) => {
      calls++;
      // calls: 1 = page1 (epoch7, next_cursor null) → loop ends; 2 = final probe.
      if (calls === 2) srv.advance(); // epoch moves to 9 right before the re-confirm
      return srv.fetchPage(cursor, expected);
    });
    const d = deps({ startEpoch: 7, fetchPage, getLocalKnown: async () => [], saveEpoch });
    const res = await reconcileMembership(d);
    expect(res).toMatchObject({ status: "done", epoch: 9 });
    // Local application can precede this check; only epoch 9 is certified.
    expect(saveEpoch).toHaveBeenCalledTimes(1);
    expect(saveEpoch).toHaveBeenCalledWith(9);
  });

  it("3. interrupted (a grant apply throws) → epoch is NOT saved, partial application does not certify an epoch", async () => {
    const srv = fakeServer([{ epoch: 7, ids: ["a", "b"] }]);
    const isolateRevoked = vi.fn(async () => {}); // revoked isolated (fail-closed) ...
    const applyProjection = vi.fn(async () => { throw new Error("network died mid-grant"); });
    const saveEpoch = vi.fn(async () => {});
    const d = deps({
      startEpoch: 7, fetchPage: srv.fetchPage,
      getLocalKnown: async () => ["z"], // z revoked, a/b granted
      isolateRevoked, applyProjection, saveEpoch,
    });
    await expect(reconcileMembership(d)).rejects.toThrow(/network died/);
    // Crucially: the epoch was NEVER persisted → the next run re-reconciles.
    expect(saveEpoch).not.toHaveBeenCalled();
    // And revoked was isolated FIRST (so even a mid-failure under-shows, never over-shows).
    expect(isolateRevoked).toHaveBeenCalledWith(expect.arrayContaining(["z"]));
  });

  it("CRITICAL (#1): a torn read (retry_required, SAME epoch) is NOT treated as an empty set — no wipe-all", async () => {
    // The dangerous case: the event cursor moved but membership_epoch did NOT, so
    // the server returns empty ids carrying the UNCHANGED epoch + retry_required.
    // If the orchestrator checked only the epoch it would accept {} and mark
    // EVERY held id revoked. It must honour retry_required and restart instead.
    let call = 0;
    const fetchPage = vi.fn(async (_cursor: string, expected: number): Promise<MembershipPage> => {
      call++;
      if (call === 1) return { ids: [], next_cursor: null, epoch: expected, event_cursor: "100", retry_required: true }; // torn, SAME epoch
      return { ids: ["a", "b"], next_cursor: null, epoch: expected, event_cursor: "100" }; // stable thereafter
    });
    const isolateRevoked = vi.fn(async () => {});
    const d = deps({
      startEpoch: 7, fetchPage,
      getLocalKnown: async () => ["a", "b", "x"], // only x is genuinely revoked
      isolateRevoked,
    });
    const res = await reconcileMembership(d);
    expect(res).toMatchObject({ status: "done" });
    // revoked = {a,b,x} − {a,b} = {x} ONLY. (Would be all three if the torn empty
    // page had been accepted — the wipe-all bug.)
    expect(isolateRevoked).toHaveBeenCalledWith(["x"]);
  });

  it("restart is bounded: a perpetually-moving epoch gives up (caller stays gated) rather than spin forever", async () => {
    let epoch = 1;
    const saveEpoch = vi.fn(async () => {});
    // Every fetch reports a NEW epoch ≠ whatever was expected → never stable.
    const fetchPage = vi.fn(async () => ({ ids: [], next_cursor: null, epoch: ++epoch, event_cursor: "100" }));
    const d = deps({ startEpoch: 0, fetchPage, saveEpoch, maxRestarts: 3 });
    const res = await reconcileMembership(d);
    expect(res.status).toBe("restart-exhausted");
    expect(saveEpoch).not.toHaveBeenCalled();
  });
});

describe("bounded hydration and version ownership", () => {
  it("hydrates more than 50,000 grants in complete, bounded batches before saving", async () => {
    const ids = Array.from({ length: 50_001 }, (_, i) => String(i).padStart(6, "0"));
    const srv = fakeServer([{ epoch: 7, ids }], 1000);
    const fetched: string[] = [], applied: string[] = [];
    const saveEpoch = vi.fn(async () => { expect(applied).toEqual(ids); });
    const result = await reconcileMembership(deps({ startEpoch: 7, fetchPage: srv.fetchPage, saveEpoch,
      fetchProjection: async (batch, epoch) => {
        expect(batch.length).toBeLessThanOrEqual(1000);
        expect(epoch).toBe(7);
        fetched.push(...batch);
        return projection(batch, epoch, "100");
      },
      applyProjection: async p => { applied.push(...p.nodes.map(n => n.id)); },
    }));
    expect(result).toMatchObject({ status: "done", granted: 50_001, eventCursor: "100" });
    expect(fetched).toEqual(ids);
    expect(saveEpoch).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("a hydration retry at the same epoch is never applied as an empty grant", async () => {
    const srv = fakeServer([{ epoch: 7, ids: ["a"] }, { epoch: 7, ids: ["b"] }]);
    let first = true;
    const applied: string[] = [];
    const result = await reconcileMembership(deps({ startEpoch: 7, fetchPage: srv.fetchPage,
      fetchProjection: async (batch, epoch) => {
        if (first) { first = false; srv.advance(); return { ...projection([], 7, "101"), retry_required: true }; }
        return projection(batch, epoch, "100");
      },
      applyProjection: async p => { applied.push(...p.nodes.map(n => n.id)); },
    }));
    expect(result).toMatchObject({ status: "done", eventCursor: "101" });
    expect(applied).toEqual(["b"]);
  });

  it("rechecks after local application, then removes a grant revoked during hydration", async () => {
    const srv = fakeServer([{ epoch: 7, ids: ["a"] }, { epoch: 8, ids: [] }]);
    const local = new Set<string>();
    const saveEpoch = vi.fn(async () => { expect(local.size).toBe(0); });
    const result = await reconcileMembership(deps({ startEpoch: 7, fetchPage: srv.fetchPage, saveEpoch,
      getLocalKnown: async () => [...local],
      isolateRevoked: async ids => { for (const id of ids) local.delete(id); },
      applyProjection: async p => { for (const n of p.nodes) local.add(n.id); srv.advance(); },
    }));
    expect(result).toMatchObject({ status: "done", epoch: 8 });
    expect(saveEpoch).toHaveBeenCalledExactlyOnceWith(8);
  });

  it("a later batch failing leaves partial rows recoverable and never saves the epoch", async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => String(i));
    const srv = fakeServer([{ epoch: 7, ids }], 1000);
    let batches = 0;
    const applyProjection = vi.fn(async () => {}), saveEpoch = vi.fn(async () => {});
    await expect(reconcileMembership(deps({ startEpoch: 7, fetchPage: srv.fetchPage, applyProjection, saveEpoch,
      fetchProjection: async (batch, epoch) => {
        if (++batches === 2) throw new Error("disconnected");
        return projection(batch, epoch, "100");
      },
    }))).rejects.toThrow("disconnected");
    expect(applyProjection).toHaveBeenCalledTimes(1);
    expect(saveEpoch).not.toHaveBeenCalled();
  });

  it("refuses an incomplete projection even when its version matches", async () => {
    const srv = fakeServer([{ epoch: 7, ids: ["a"] }]);
    const saveEpoch = vi.fn(async () => {}), applyProjection = vi.fn(async () => {});
    await expect(reconcileMembership(deps({ startEpoch: 7, fetchPage: srv.fetchPage, saveEpoch, applyProjection,
      fetchProjection: async () => projection([], 7, "100"),
    }))).rejects.toThrow("projection is incomplete");
    expect(applyProjection).not.toHaveBeenCalled();
    expect(saveEpoch).not.toHaveBeenCalled();
  });

  it("a newly created local id after the baseline is outside this revoke operation", async () => {
    const local = new Set(["a"]);
    const isolateRevoked = vi.fn(async () => {});
    const result = await reconcileMembership(deps({ startEpoch: 7, isolateRevoked,
      getLocalKnown: async () => [...local],
      fetchPage: async () => { local.add("local-draft"); return { ids: ["a"], epoch: 7, event_cursor: "100", next_cursor: null }; },
    }));
    expect(result.status).toBe("done");
    expect(isolateRevoked).toHaveBeenCalledExactlyOnceWith([]);
  });

  it.each([undefined, "", "1e2", "-1"])("refuses missing or malformed event cursor %s without deleting local data", async event_cursor => {
    const isolateRevoked = vi.fn(async () => {}), saveEpoch = vi.fn(async () => {});
    await expect(reconcileMembership(deps({ startEpoch: 7, isolateRevoked, saveEpoch,
      getLocalKnown: async () => ["a"],
      fetchPage: async () => ({ ids: [], next_cursor: null, epoch: 7, event_cursor } as MembershipPage),
    }))).rejects.toThrow("valid snapshot version");
    expect(isolateRevoked).not.toHaveBeenCalled();
    expect(saveEpoch).not.toHaveBeenCalled();
  });
});

// ── The digest first (GET /sync/membership/digest) ───────────────────────────
// The fake server computes the digest with node:crypto — the backend's own
// hash — so these also pin the client's rule to the server's.

const nodeSha = (ids: string[]) => createHash("sha256").update(ids.join("\n"), "utf8").digest("hex");
function serverDigest(ids: string[]) {
  const sorted = [...ids].sort();
  const groups = new Map<string, string[]>();
  for (const id of sorted) groups.set(id.slice(0, 2), [...(groups.get(id.slice(0, 2)) ?? []), id]);
  return { count: sorted.length, digest: nodeSha(sorted), buckets: Object.fromEntries([...groups].map(([k, g]) => [k, nodeSha(g).slice(0, 16)])) };
}
// Ids spread over many buckets: "<2 hex>-<n>".
const idsIn = (n: number) => Array.from({ length: n }, (_, i) => `${(i % 256).toString(16).padStart(2, "0")}-${i}`);

function digestServer(state: { epoch: number; ids: string[]; tags?: MembershipDigest["tags"] }, pageSize = 1000) {
  const fetchDigest = vi.fn(async (expected: number): Promise<MembershipDigest> =>
    expected !== state.epoch
      ? { epoch: state.epoch, event_cursor: "200", retry_required: true }
      : { epoch: state.epoch, event_cursor: "200", ...serverDigest(state.ids), ...(state.tags ? { tags: state.tags } : {}) });
  const fetchPage = vi.fn(async (cursor: string, expected: number, prefixes?: readonly string[]): Promise<MembershipPage> => {
    if (expected !== state.epoch) return { ids: [], next_cursor: null, epoch: state.epoch, event_cursor: "200", retry_required: true };
    const scoped = state.ids.filter((id) => !prefixes || prefixes.includes(id.slice(0, 2))).sort();
    const start = cursor ? scoped.findIndex((id) => id > cursor) : 0;
    const slice = start < 0 ? [] : scoped.slice(start, start + pageSize);
    return { ids: slice, next_cursor: slice.length === pageSize ? slice[slice.length - 1]! : null, epoch: state.epoch, event_cursor: "200" };
  });
  return { fetchDigest, fetchPage };
}

describe("reconcileMembership — digest first", () => {
  const sha256 = webCryptoSha256()!;

  it("the client's digest is the server's (same ids, any order, duplicates once)", async () => {
    const ids = idsIn(700);
    const local = await membershipDigestOf([...ids].reverse().concat(ids.slice(0, 5)), sha256);
    expect(local).toEqual(serverDigest(ids));
  });

  it("equal sets: one digest request, no pages, nothing revoked or granted; catalog applied, epoch saved", async () => {
    const ids = idsIn(3000);
    const srv = digestServer({ epoch: 4, ids, tags: [] });
    const applyProjection = vi.fn(async () => {});
    const d = deps({ startEpoch: 4, fetchPage: srv.fetchPage, fetchDigest: srv.fetchDigest, sha256,
      getLocalKnown: async () => [...ids].reverse(), applyProjection });
    const res = await reconcileMembership(d);
    expect(res).toMatchObject({ status: "done", epoch: 4, eventCursor: "200", revoked: 0, granted: 0 });
    expect(srv.fetchDigest).toHaveBeenCalledTimes(1);
    expect(srv.fetchPage).not.toHaveBeenCalled();
    expect(d.isolateRevoked).not.toHaveBeenCalled();
    expect(d.fetchProjection).not.toHaveBeenCalled();
    expect(applyProjection).toHaveBeenCalledWith(expect.objectContaining({ tags: [], nodes: [] }));
    expect(d.saveEpoch).toHaveBeenCalledWith(4);
  });

  it("onSetDiffers: not called for an equal set, called before anything is revoked for a differing one", async () => {
    const ids = idsIn(300);
    const same = digestServer({ epoch: 4, ids });
    const calm = vi.fn();
    await reconcileMembership(deps({ startEpoch: 4, fetchPage: same.fetchPage, fetchDigest: same.fetchDigest, sha256,
      getLocalKnown: async () => ids, onSetDiffers: calm }));
    expect(calm).not.toHaveBeenCalled();

    const order: string[] = [];
    const diff = digestServer({ epoch: 5, ids });
    await reconcileMembership(deps({ startEpoch: 5, fetchPage: diff.fetchPage, fetchDigest: diff.fetchDigest, sha256,
      getLocalKnown: async () => [...ids, "a7-revoked"], onSetDiffers: () => order.push("gate"),
      isolateRevoked: async () => { order.push("revoke"); } }));
    expect(order).toEqual(["gate", "revoke"]);
  });

  it("onSetDiffers: a server with no digest cannot say the set is equal, so it is called", async () => {
    const ids = idsIn(20);
    const srv = digestServer({ epoch: 1, ids });
    const fetchDigest = vi.fn(async (): Promise<MembershipDigest> => ({ epoch: 1, event_cursor: "200" }));
    const gate = vi.fn();
    await reconcileMembership(deps({ startEpoch: 1, fetchPage: srv.fetchPage, fetchDigest, sha256, getLocalKnown: async () => ids, onSetDiffers: gate }));
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("a revoked note is still removed: only its bucket is paged, and the confirm stays scoped", async () => {
    const ids = idsIn(3000);
    const revokedId = "a7-revoked";
    const srv = digestServer({ epoch: 9, ids });
    const d = deps({ startEpoch: 9, fetchPage: srv.fetchPage, fetchDigest: srv.fetchDigest, sha256,
      getLocalKnown: async () => [...ids, revokedId] });
    const res = await reconcileMembership(d);
    expect(res).toMatchObject({ status: "done", epoch: 9, revoked: 1, granted: 0 });
    expect(d.isolateRevoked).toHaveBeenCalledWith([revokedId]);
    expect(srv.fetchPage.mock.calls.length).toBeGreaterThan(0);
    for (const call of srv.fetchPage.mock.calls) expect(call[2]).toEqual(["a7"]);
    expect(d.saveEpoch).toHaveBeenCalledWith(9);
  });

  it("a newly readable note is fetched from its bucket's page", async () => {
    const ids = idsIn(1000);
    const srv = digestServer({ epoch: 2, ids: [...ids, "0c-new"] });
    const d = deps({ startEpoch: 2, fetchPage: srv.fetchPage, fetchDigest: srv.fetchDigest, sha256, getLocalKnown: async () => ids });
    expect(await reconcileMembership(d)).toMatchObject({ status: "done", revoked: 0, granted: 1 });
    expect(d.fetchProjection).toHaveBeenCalledWith(["0c-new"], 2);
  });

  it("many differing buckets: pages the whole set, and still removes every revoked note", async () => {
    const ids = idsIn(1000);
    const revoked = Array.from({ length: 100 }, (_, i) => `${(i * 2).toString(16).padStart(2, "0")}-gone`);
    const srv = digestServer({ epoch: 5, ids });
    const d = deps({ startEpoch: 5, fetchPage: srv.fetchPage, fetchDigest: srv.fetchDigest, sha256,
      getLocalKnown: async () => [...ids, ...revoked] });
    expect(await reconcileMembership(d)).toMatchObject({ status: "done", revoked: 100 });
    expect(d.isolateRevoked).toHaveBeenCalledWith(expect.arrayContaining(revoked));
    for (const call of srv.fetchPage.mock.calls) expect(call[2]).toBeUndefined();
  });

  it("a stale epoch on the digest restarts with the server's epoch (never trusts it)", async () => {
    const ids = idsIn(10);
    const srv = digestServer({ epoch: 6, ids });
    const d = deps({ startEpoch: 5, fetchPage: srv.fetchPage, fetchDigest: srv.fetchDigest, sha256, getLocalKnown: async () => ids });
    expect(await reconcileMembership(d)).toMatchObject({ status: "done", epoch: 6 });
    expect(srv.fetchDigest).toHaveBeenCalledTimes(2);
    expect(d.saveEpoch).toHaveBeenCalledTimes(1);
    expect(d.saveEpoch).toHaveBeenCalledWith(6);
  });

  it("an older server without digests: pages everything and removes the revoked note", async () => {
    const ids = idsIn(50);
    const srv = digestServer({ epoch: 1, ids });
    const fetchDigest = vi.fn(async (): Promise<MembershipDigest> => ({ epoch: 1, event_cursor: "200" }));
    const d = deps({ startEpoch: 1, fetchPage: srv.fetchPage, fetchDigest, sha256, getLocalKnown: async () => [...ids, "ff-gone"] });
    expect(await reconcileMembership(d)).toMatchObject({ status: "done", revoked: 1 });
    expect(d.isolateRevoked).toHaveBeenCalledWith(["ff-gone"]);
    for (const call of srv.fetchPage.mock.calls) expect(call[2]).toBeUndefined();
  });

  it("D2: an unequal total with every bucket equal (forged buckets) pages everything and still revokes", async () => {
    const ids = idsIn(300);
    const srv = digestServer({ epoch: 3, ids });
    const local = [...ids, "a1-revoked"];
    const forged = vi.fn(async (expected: number): Promise<MembershipDigest> => {
      const real = await srv.fetchDigest(expected);
      return { ...real, buckets: (await membershipDigestOf(local, sha256)).buckets }; // buckets claim equality
    });
    const d = deps({ startEpoch: 3, fetchPage: srv.fetchPage, fetchDigest: forged, sha256, getLocalKnown: async () => local });
    expect(await reconcileMembership(d)).toMatchObject({ status: "done", revoked: 1 });
    expect(d.isolateRevoked).toHaveBeenCalledWith(["a1-revoked"]);
    for (const call of srv.fetchPage.mock.calls) expect(call[2]).toBeUndefined(); // never an empty scope
  });
});
