import type { SyncDelta } from "../localDb";
import { bucketOf, membershipDigestOf, unequalBuckets, type Sha256Hex } from "./membershipDigest";

/** Version of a readable set and its projection. event_cursor is a decimal
 * string: where the event log stood when the server read the set. It does NOT
 * acknowledge that the client scanned events, and between pages only the epoch
 * is pinned (creations and deletions after the first read arrive as events). */
export type MembershipVersion = { epoch: number; event_cursor: string };
export type MembershipPage = MembershipVersion & {
  ids: string[];
  next_cursor: string | null;
  /** A stale expectation, never an empty readable set. */
  retry_required?: boolean;
  /** First page only: complete catalog from this checked read snapshot. */
  tags?: SyncDelta["tags"];
};
/** GET /api/sync/membership/digest (membershipDigest.ts has the rule). An
 *  older server answers without `digest`: the reconcile then pages. */
export type MembershipDigest = MembershipVersion & {
  count?: number;
  digest?: string;
  buckets?: Record<string, string>;
  retry_required?: boolean;
  tags?: SyncDelta["tags"];
};
export type MembershipProjection = MembershipVersion & {
  nodes: SyncDelta["nodes"]["upsert"];
  attributes: SyncDelta["attributes"];
  edges: SyncDelta["edges"]["upsert"];
  tasks: SyncDelta["tasks"]["upsert"];
  /** Pointers touching the requested nodes; absent from older servers. */
  pointers?: NonNullable<SyncDelta["pointers"]>["upsert"];
  /** Paragraph anchors of the requested notes; absent from older servers. */
  note_anchors?: SyncDelta["note_anchors"];
  note_link_bindings?: SyncDelta["note_link_bindings"];
  retry_required?: boolean;
  tags?: SyncDelta["tags"];
};

export type ReconcileDeps = {
  startEpoch: number;
  /** One page of the readable ids, valid only while the epoch is `expectedEpoch`. */
  fetchPage: (cursor: string, expectedEpoch: number, prefixes?: readonly string[]) => Promise<MembershipPage>;
  /** The server set's digest. With `sha256`, compared first: equal sets need
   *  no pages; unequal ones page only the buckets that differ. */
  fetchDigest?: (expectedEpoch: number) => Promise<MembershipDigest>;
  sha256?: Sha256Hex;
  /** Complete held node ∪ task ids, captured before each pagination attempt. */
  getLocalKnown: () => Promise<string[]>;
  /** Remove access before applying grants. Caller keeps the display gated. */
  /** `version`: the readable set these ids were left out of, as read (its event_cursor is where it was read). */
  isolateRevoked: (revoked: string[], version: { epoch: number; event_cursor: string | undefined }) => Promise<void>;
  /** Fetch a bounded batch, valid only while the epoch is `expectedEpoch`. */
  fetchProjection: (ids: string[], expectedEpoch: number) => Promise<MembershipProjection>;
  /** Apply every channel, preserving the existing event cursor. */
  applyProjection: (projection: MembershipProjection) => Promise<void>;
  /** Persist only after all batches and the final version check succeed. */
  saveEpoch: (epoch: number) => Promise<void>;
  /** The held set is NOT the server's (or no digest could say): called before
   *  anything is revoked or granted, so the caller can raise its display gate
   *  only now rather than for every epoch change. */
  onSetDiffers?: () => void;
  maxRestarts?: number;
};

export type ReconcileResult =
  | { status: "done"; epoch: number; eventCursor: string; revoked: number; granted: number }
  | { status: "restart-exhausted"; lastEpoch: number };

const PAST_ALL_IDS = "￿";
const HYDRATION_BATCH_SIZE = 1000;
/** Past this many unequal buckets (of 256) the scoped pages would carry most
 *  of the set anyway: page all of it. */
const MAX_SCOPED_BUCKETS = 64;
const HEX_BUCKET = /^[0-9a-f]{2}$/;

function matches(actual: MembershipVersion & { retry_required?: boolean }, epoch: number) {
  // An old/malformed server must not certify a cross-request snapshot.
  if (!Number.isSafeInteger(actual.epoch) || actual.epoch < 0
    || typeof actual.event_cursor !== "string" || !/^(0|[1-9]\d*)$/.test(actual.event_cursor)) {
    throw new Error("membership response is missing a valid snapshot version");
  }
  return !actual.retry_required && actual.epoch === epoch;
}

/** Reconcile behind the caller's display gate. The epoch is checked on every
 * page/batch and again AFTER local application. Drift restarts from current
 * local state; I/O failures propagate. Partial local changes can remain, but
 * never certify a new epoch. After `done`, scan deltas through eventCursor
 * before reporting sync complete; never assign it to last_event_id directly. */
export async function reconcileMembership(deps: ReconcileDeps): Promise<ReconcileResult> {
  let expected = deps.startEpoch;
  attempts: for (let attempt = 0; attempt <= (deps.maxRestarts ?? 5); attempt++) {
    // IDs created locally while paging are outside this revoke operation.
    // With digests, the held set is read and hashed while the digest request
    // is in flight (the hash is only compared, never used to revoke).
    const { fetchDigest, sha256 } = deps;
    const [[localKnown, local], remote] = fetchDigest && sha256
      ? await Promise.all([
        deps.getLocalKnown().then(async ids => { const held = new Set(ids); return [held, await membershipDigestOf(held, sha256)] as const; }),
        fetchDigest(expected),
      ])
      : [[new Set(await deps.getLocalKnown()), undefined] as const, undefined];
    const readable = new Set<string>();
    let cursor = "";
    // Where the event log stood at this attempt's first read.
    let eventCursor: string | undefined;
    let tags: SyncDelta["tags"];
    // The digest first. Its version, set and tag catalog are one snapshot, so
    // an equal set is current as of that version: nothing to page or apply
    // but the catalog. Unequal: page only the differing buckets (or all).
    let scope: string[] | undefined;
    if (remote && local) {
      if (remote.retry_required || typeof remote.digest === "string") {
        if (!matches(remote, expected)) { expected = remote.epoch; continue attempts; }
        if (local.digest === remote.digest && local.count === remote.count) {
          const version = { epoch: expected, event_cursor: remote.event_cursor };
          if (remote.tags !== undefined) {
            await deps.applyProjection({ ...version, nodes: [], edges: [], tasks: [],
              attributes: { upsert: [], delete: [] }, tags: remote.tags });
          }
          await deps.saveEpoch(expected);
          return { status: "done", epoch: expected, eventCursor: remote.event_cursor, revoked: 0, granted: 0 };
        }
        deps.onSetDiffers?.();
        const differing = unequalBuckets(local.buckets, remote.buckets ?? {});
        // No unequal bucket under an unequal total (forged or inconsistent
        // buckets) is no scope: page everything. An empty scope would revoke
        // nothing.
        if (remote.buckets && differing.length > 0 && differing.length <= MAX_SCOPED_BUCKETS && differing.every((key) => HEX_BUCKET.test(key))) {
          scope = differing;
        }
        eventCursor = remote.event_cursor;
      }
    }
    if (!remote || !local || typeof remote.digest !== "string") deps.onSetDiffers?.(); // no digest to say it is equal
    const inScope = scope ? new Set(scope) : null;
    for (;;) {
      const page = await deps.fetchPage(cursor, expected, scope);
      if (!matches(page, expected)) { expected = page.epoch; continue attempts; }
      eventCursor ??= page.event_cursor;
      if (cursor === "") tags = page.tags;
      for (const id of page.ids) readable.add(id);
      if (page.next_cursor === null) break;
      if (page.next_cursor <= cursor) throw new Error("membership pagination did not advance");
      cursor = page.next_cursor;
    }
    const version = { epoch: expected, event_cursor: eventCursor };
    // Scoped: a bucket outside the scope has equal digests, so equal ids.
    const revoked = [...localKnown].filter(id => (!inScope || inScope.has(bucketOf(id))) && !readable.has(id));
    const granted = [...readable].filter(id => !localKnown.has(id));
    await deps.isolateRevoked(revoked, version);
    for (let offset = 0; offset < granted.length; offset += HYDRATION_BATCH_SIZE) {
      const ids = granted.slice(offset, offset + HYDRATION_BATCH_SIZE);
      const projection = await deps.fetchProjection(ids, expected);
      if (!matches(projection, expected)) { expected = projection.epoch; continue attempts; }
      const received = new Set([...projection.nodes, ...projection.tasks].map(row => row.id));
      if (ids.some(id => !received.has(id))) throw new Error("membership projection is incomplete");
      await deps.applyProjection(projection);
    }
    if (tags !== undefined) {
      await deps.applyProjection({ ...version, nodes: [], edges: [], tasks: [],
        attributes: { upsert: [], delete: [] }, tags });
    }
    const confirm = await deps.fetchPage(PAST_ALL_IDS, expected, scope);
    if (!matches(confirm, expected)) { expected = confirm.epoch; continue; }
    await deps.saveEpoch(expected);
    return { status: "done", epoch: expected, eventCursor, revoked: revoked.length, granted: granted.length };
  }
  return { status: "restart-exhausted", lastEpoch: expected };
}
