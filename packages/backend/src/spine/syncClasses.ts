// Which kind of data every table holds, for copying it between nodes (docs/architecture/proposals/causal-stamps-2026-11-12.md §4).
// Anyone adding a table answers "what does this do on two devices that were both offline?" by choosing a class here;
// src/test/syncClasses.integration.test.ts fails for a table that is not in this list.
//
//   stamped      original data that will be copied between nodes: each row (or field) carries a write stamp
//                (spine/stamps.ts). `wired` says whether a trigger records the stamps yet (S1: content_nodes; S2, migration 194: node_attributes, node_tags, block_node_tags, node_edges, note_pointers, node_positions; S3, migration 199: spaces, space_members, workspaces, plus the JSON columns of content_nodes).
//   derived      every node works it out itself from the stamped data; never copied.
//   node-local   belongs to this node only (ledger, queues, sessions, credentials); never copied.
//   separate     needs its own answer (attachments, identity); decided after launch.
//   undecided    the proposal does not name the table. The list may only shrink (ratchet), and a new table cannot
//                be added as undecided.
//
// The table itself is syncClasses.json, next to this file.

import classes from "./syncClasses.json" with { type: "json" };

export type SyncClass = "stamped" | "derived" | "node-local" | "separate" | "undecided";
export type SyncClassEntry = { class: SyncClass; note: string; wired?: true };

/** The class of every table, by table name (the data is syncClasses.json: a plain table, one line per table). */
export const SYNC_CLASSES: Record<string, SyncClassEntry> = classes as Record<string, SyncClassEntry>;

/** Tables a stamp trigger is attached to today (db/migrations/190_sync_stamps.sql): S1 wired content_nodes, S2 (194) six more, S3 (199) three more: the `wired` entries in syncClasses.json. */
export const WIRED_TABLES = Object.entries(SYNC_CLASSES).filter(([, e]) => e.wired).map(([name]) => name);
