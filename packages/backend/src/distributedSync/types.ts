// Distributed sync (beta): the shapes every piece shares. Design: docs/architecture/distributed-sync.md.
//
// One replicated thing: an OP, a signed-in-spirit statement "actor A did X to note N" with a
// hybrid logical clock. Nodes exchange ops; state is a pure function of the set of valid ops
// (materialize.ts), so two nodes holding the same valid ops hold the same state.

import { CURRENT_BODY_MERGE_RULE, type BodyMergeRule } from "../services/eventLog/index.js";

/** The body merge rule's version: 1 = line merge only, 2 = + moved paragraphs and move/move conflicts (services/eventLog/bodyMergeMoves.ts, `mergeBody`),
 *  3 = characters merged one paired line at a time (bodyMerge.ts `mergeLineByLine`), and a conflict that would hold lines twice is a conflict of
 *  the whole text. `mergeBody(…, rule)` still computes 1 and 2 as they were.
 *  Nodes on different versions compute different bodies, so a change to what `mergeBody` returns adds one to CURRENT_BODY_MERGE_RULE (bodyMerge.ts) and the sync version gate
 *  (docs/architecture/proposals/node-sync-channels-2026-11-14.md item 12; not built yet, sync is off) refuses to merge across versions. */
export const BODY_MERGE_RULE_VERSION: BodyMergeRule = CURRENT_BODY_MERGE_RULE;

/** A device or server that holds a copy. Stable for the life of its database. */
export type NodeId = string;
/** A person (or agent) the permission model talks about. Not a login: a node vouches for its own actors. */
export type ActorId = string;
export type SpaceId = string;
export type NoteId = string;
/** `<origin node>:<sequence number at that node>`, e.g. "phone:12". Unique, never reused. */
export type OpId = string;

/** What an actor may do in a space. `suggest` is the stranger role of a collaboration link: read, and
 *  propose text, never change the note. `none` only appears as the value of a revoking member.set. */
export type Role = "none" | "view" | "suggest" | "edit";
export const ROLE_RANK: Record<Role, number> = { none: 0, view: 1, suggest: 2, edit: 3 };

/** Hybrid logical clock reading: wall = milliseconds (or any monotone integer), counter breaks ties. */
export type Hlc = { wall: number; counter: number };

export type OpBody =
  /** The author becomes the space's owner (the only one who manages members). `ownerRole` is the owner's own access: a personal
   *  or freshly created space gives `edit`; a workspace owner who manages a shared space without being a member of it is `none`. */
  | { kind: "space.create"; space: SpaceId; name: string; ownerRole?: Role }
  | { kind: "member.set"; space: SpaceId; actor: ActorId; role: Role }
  | { kind: "note.create"; note: NoteId; noteKind: "content" | "tag"; title: string; body: string; parent: NoteId | null }
  | { kind: "note.title"; note: NoteId; title: string }
  /** `before` is the body the author edited; the merge is three-way against whatever the state holds when the op lands. */
  | { kind: "note.body"; note: NoteId; before: string; after: string }
  | { kind: "note.tag"; note: NoteId; tag: NoteId; on: boolean }
  | { kind: "note.move"; note: NoteId; parent: NoteId | null }
  | { kind: "note.delete"; note: NoteId }
  | { kind: "note.restore"; note: NoteId }
  /** A proposal from someone who may not edit: recorded on the note, never applied to its text. */
  | { kind: "note.suggest"; note: NoteId; text: string };

export type OpKind = OpBody["kind"];

/** Tag definitions are global in the real model (no space; every member of any space reads them, the workspace owner changes them).
 *  The engine keeps them in one pseudo space per workspace whose id starts with this prefix: see materialize.roleIn. */
export const GLOBAL_TAG_SPACE_PREFIX = "tags:";
export const isGlobalTagSpace = (space: SpaceId): boolean => space.startsWith(GLOBAL_TAG_SPACE_PREFIX);

/** Genesis ops (doc §9) are made by no real node: every copy of one server derives the same ones. Their origin and clock are fixed. */
export const GENESIS_ORIGIN = "genesis";
export const GENESIS_HLC: Hlc = { wall: 0, counter: 0 };

export type Op = {
  id: OpId;
  origin: NodeId;
  /** Position in the origin's own log: 1, 2, 3 … with no gaps. */
  seq: number;
  hlc: Hlc;
  author: ActorId;
  /** The space this op belongs to. The permission scope, and what decides who is sent it. Checked against the note's real space. */
  space: SpaceId;
  body: OpBody;
};

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Which seqs of each origin a node holds, as inclusive [from, to] runs. */
export type Have = Record<NodeId, Array<[number, number]>>;

export type SyncMessage =
  | { type: "offer"; from: NodeId; to: NodeId; have: Have; /** the receiver should send its own offer back */ reply: boolean }
  | { type: "ops"; from: NodeId; to: NodeId; ops: Op[] };

/** The SQL a node runs on. The engine never touches the process-wide `pool`, so several nodes live in one process (tests) and
 *  a later HTTP/relay/WebRTC node is just another SyncDb behind the same engine. */
export interface SyncDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: SyncDb) => Promise<T>): Promise<T>;
}

/** Which actors each node may speak for. Fixed when two nodes pair; signatures replace it later (doc §6). */
export type NodeDirectory = Record<NodeId, ActorId[]>;
