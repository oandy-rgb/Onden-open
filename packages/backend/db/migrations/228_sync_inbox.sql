-- 228: a change bundle is taken in bounded segments through a node-local inbox (docs/architecture/proposals/own-node-transport-2026-11-22.md §2.10, batch 6;
-- spine/stampedInbox.ts). Only adds a table: no existing table, row, function or trigger is changed.
--
-- WHY. Taking a bundle was one transaction under the workspace's event lock: 5,000 notes held it for 95 s, and every local save waited (PGlite has one
-- connection and gives up after 10 s). Now the pages are written here one short transaction each; once the last page is in and the bundle passed its
-- checks, the plan (the segments) is written here too, and each segment is taken in a transaction of its own that also removes its row. A process that
-- dies after any segment goes on by itself at the next start, from what is here: the sender is never asked again.
--
-- ONE TABLE, four kinds of rows per workspace (at most one bundle at a time: while a row is here, this node takes and reads no other bundle, `peer_busy`):
--   kind 'header',  n 0        the bundle's header (sender, cut, base, upTo, holds, pages), its state ('receiving' | 'planned'), how many segments, the
--                              highest clock reading of the bundle (for the finishing step) and the time it arrived
--   kind 'page',    n 1..P     one page of the bundle as it arrived (its items), until the plan is written
--   kind 'segment', n 1..S     one segment of the plan (its items), until it is taken
--   kind 'outcome', n 0        a bundle this node gave up on, with one plain sentence for the person (a screen of a later batch shows it); not "busy": it is no bundle
-- node-local (spine/syncClasses.json): never in a snapshot or a bundle. A backup of the whole database holds it; the header names the node id it was planned on, and a
-- database restored under a new node id gives that inbox up at its first start (spine/stampedImport.ts resumeChangeBundles).
CREATE TABLE IF NOT EXISTS sync_inbox (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('header', 'page', 'segment', 'outcome')),
  n integer NOT NULL CHECK (n >= 0),
  content jsonb NOT NULL,
  PRIMARY KEY (workspace_id, kind, n),
  CHECK ((kind IN ('header', 'outcome')) = (n = 0))
);
