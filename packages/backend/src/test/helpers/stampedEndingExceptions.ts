// The tests of bundles and snapshots whose ending (helpers/stampedEnding.ts: one more exchange round between every pair and a full resend, nothing stored, nothing refused,
// nothing changed, the same stamps, heads and values on every node) is not run as it is for every other test. The key is "file > describe > … > test" as vitest names it;
// a key ending in " > *" covers every test under that describe (only for a file whose tests share one world through a module-level memo: the one that builds it ends it);
// "<file> > (outside a test)" is what the file's beforeAll exchanged.
// Two lists, each shrink-only on its own (scripts/ratchetLib.mjs, `npm run ratchet:check`), so a finding cannot be moved to "skipped" without one list growing.

import type { Difference } from "./stampedEndingNames.js";

/** A pinned finding: why (its README line), and which of the ending's differences are it (`allows`, given each difference and all of them). The ending runs every
 *  step on every node; the differences `allows` takes are this finding, every other one is red as in an unpinned test, and a pinned test whose ending finds none of
 *  its own is red too (the finding is gone: take the entry and its README line out). */
export type PinnedFinding = { why: string; allows: (d: Difference, all: readonly Difference[]) => boolean };
const stampOf = (d: Difference, table: string, field: string) => (d.kind === "stamp" || d.kind === "head") && d.item.table_name === table && d.item.field === field;
const resendStored = (d: Difference, table: string, field?: string) =>
  d.kind === "stored" && d.step === "full resend" && d.unit !== null && d.unit.table === table && (field === undefined || d.unit.field === field);
/** A note's value that differs from another node's only in `parent`, on a row whose `parent` stamp one node holds and the other not (the row the cleared parent is on). */
const onlyParentDiffers = (d: Difference, all: readonly Difference[]): boolean => {
  if (d.kind !== "value" || d.label !== "content_nodes") return false;
  if (!all.some((o) => o.kind === "stamp" && stampOf(o, "content_nodes", "parent") && o.item.row_key === d.row)) return false;
  const other = all.find((o): o is Extract<Difference, { kind: "value" }> => o.kind === "value" && o.label === d.label && o.row === d.row && o.onlyOn === d.other && o.other === d.onlyOn);
  if (!other) return false;
  const rest = (text: string) => { const { parent, ...r } = JSON.parse(text) as Record<string, unknown>; return parent === undefined ? null : JSON.stringify(r); };
  const [mine, theirs] = [rest(d.text), rest(other.text)];
  return mine !== null && mine === theirs;
};
const TASK_COPY: PinnedFinding = {
  why: "README 接上傳輸前必須完成: 段落列與它的任務在同一個交易裡建立時，寫的那台多一個 `task` 欄位標記 (the writer holds a copy of the creation stamp for `task`, the receiver does not)",
  // a paragraph row's `task` stamp that repeats the row's creation stamp, held by one node only, the other holding that same creation stamp
  allows: (d) => d.kind === "stamp" && stampOf(d, "block_nodes", "task") && d.copyOfCreation,
};
const ANCHOR_HEADS_FLIP: PinnedFinding = {
  why: "README 接上傳輸前必須完成: 錨點單位有兩個頭時，什麼都沒存的一輪或整份重送讓這台的錨點列換成另一個頭 (the anchor rows change though nothing is stored)",
  // an anchor row of a node that is another row after the two steps (the same anchor id before and after): not an anchor row that came or went
  allows: (d, all) => d.kind === "row" && d.table === "block_anchors"
    && all.some((o) => o.kind === "row" && o.peer === d.peer && o.table === d.table && o.side !== d.side && o.row.anchor_id === d.row.anchor_id),
};
/** How far an origin is held, without the labels held up to 0. */
const held = (have: unknown) => Object.fromEntries(Object.entries((have ?? {}) as Record<string, number>).filter(([, n]) => n !== 0));
/** A row of sync_origins that one more round or the full resend wrote with labels held up to 0 (`{}` became `{"spaces": 0, …}`, or a row of nothing for an origin
 *  the sender named): the same origin, writer and every other column, and the same holdings but for those zeros. In the nodeRenewal pins it is one more round: the
 *  node that joined the restored server learns B (admitted, nothing taken) in the first round and names it back in the next. */
const ZEROS_WRITTEN_OUT: PinnedFinding = {
  why: "README 接上傳輸前必須完成: 一個准許了、卻什麼都沒收過的來源（`{}`），只要有一個包列出它，就被寫成每個標籤 0，之後從這台做的快照會把那些來源帶出去 (a bundle naming an origin held as `{}` writes every label at 0 into sync_origins; snapshots then carry that origin)",
  allows: (d, all) => {
    if (d.kind !== "row" || d.table !== "sync_origins") return false;
    const counterpart = all.find((o) => o.kind === "row" && o.peer === d.peer && o.table === d.table && o.side !== d.side && o.row.origin === d.row.origin) as Extract<Difference, { kind: "row" }> | undefined;
    const [before, after] = d.side === "before" ? [d.row, counterpart?.row] : [counterpart?.row, d.row];
    if (!after) return false;
    const rest = (r: Record<string, unknown>) => JSON.stringify({ ...r, have: held(r.have) });
    return before ? rest(before) === rest(after) : Object.keys(held(after.have)).length === 0;
  },
};

// FINDINGS, pinned: the ending must still find each, and nothing else (when it finds none of it, or anything more, the run fails). Each has a line under
// 「接上傳輸前必須完成」 in spine/stampedMerge/README.md.
// ratchet:list stamped-ending-fails
export const ENDING_FAILS: Record<string, PinnedFinding> = {
  "anchorIdsTwoNodes.integration.test.ts > the ids a body write mints, on two nodes that hold the same text > *":
    { ...TASK_COPY, why: `${TASK_COPY.why}; the file builds one world in whichever of its tests runs first (a module-level memo, \`probe\`): that test has the ending` },
  "anchorsReplicated.integration.test.ts > a body write's anchors, paragraph rows and task notes on three nodes > 9: the same new task line written on two nodes: two anchors and two tasks after the exchange, one row shown on both; the next save on each keeps that row":
    TASK_COPY,
  "anchorsReplicated.integration.test.ts > a body write's anchors, paragraph rows and task notes on three nodes > A writes a task line, B edits the line's text, C ticks it: one task note everywhere, with all three changes":
    TASK_COPY,
  "anchorsReplicated.integration.test.ts > a body write's anchors, paragraph rows and task notes on three nodes > a body conflict that is kept: each version's anchors stay with it, the same on both nodes":
    TASK_COPY,
  "anchorsReplicated.integration.test.ts > a body write's anchors, paragraph rows and task notes on three nodes > a node that is offline while the anchors are reassigned takes them as they are when it comes back":
    TASK_COPY,
  "anchorsReplicated.integration.test.ts > a body write's anchors, paragraph rows and task notes on three nodes > find again meets a note whose anchors unit has two heads: refused, the heads stay; elsewhere taken; never a write without mutate":
    ANCHOR_HEADS_FLIP,
  "anchorsReplicated.integration.test.ts > a body write's anchors, paragraph rows and task notes on three nodes > round 10, 4 (stamps): what differs today: B keeps a stamp row of K's parent holding P's id, A none":
    { why: "README 接上傳輸前必須完成: 外鍵清空的欄位，被指的那一列之後以同一個 id 再建 (B keeps a parent stamp A has not; K is under P on A, at the top on B)", allows: (d, all) => (d.kind === "stamp" && stampOf(d, "content_nodes", "parent")) || onlyParentDiffers(d, all) },
  "anchorsReplicated.integration.test.ts > a body write's anchors, paragraph rows and task notes on three nodes > round 3, 1: a body-only bundle makes another head the one on the stored body: the receiver's rows show that head":
    ANCHOR_HEADS_FLIP,
  "anchorsReplicated.integration.test.ts > a body write's anchors, paragraph rows and task notes on three nodes > the same series of body writes, taken in different batches and orders, leaves the same anchors, paragraph rows and task notes (ids included) on all three":
    TASK_COPY,
  "nodeRenewal.integration.test.ts > what a snapshot names as the former ids of its source, and what a join takes from it > a former value that is not node ids with whole numbers is refused whole (join_bad_former), the source must be a node id (join_bad_source); the shell can still join after":
    ZEROS_WRITTEN_OUT,
  "nodeRenewal.integration.test.ts > what a snapshot names as the former ids of its source, and what a join takes from it > a renewed server that also holds a real foreign origin gives a snapshot (former + brought); a device that joined from a renewed server gives one too":
    ZEROS_WRITTEN_OUT,
  "nodeRenewal.integration.test.ts > what a snapshot names as the former ids of its source, and what a join takes from it > a server renewed before migration 215's labels (its former id's row names 19 labels) is a source; the device that joins holds what it holds":
    ZEROS_WRITTEN_OUT,
  "nodeRenewal.integration.test.ts > what a snapshot names as the former ids of its source, and what a join takes from it > the empty database's own sync_origins rows (a shell that was restored and renewed, or that admitted a node) go with its workspace when the join begins":
    ZEROS_WRITTEN_OUT,
  "nodeRenewal.integration.test.ts > what a snapshot names as the former ids of its source, and what a join takes from it > through the snapshot routes (the stream: hello and pages carry former), a restored and renewed server fills an empty database that then holds both of its ids":
    ZEROS_WRITTEN_OUT,
  "receivedDerivation.integration.test.ts > what a node derives from a bundle it took (batch 4a) > P1 + P2 + P5: a body with links, paragraphs, a task line and text values, edited on both nodes, delivered in both orders and sent again: no unit is written by the derivation, the derived rows are the same, one task":
    TASK_COPY,
  "receivedDerivation.integration.test.ts > what a node derives from a bundle it took (batch 4a) > a bundle never publishes: notes that are not published on the node that wrote them are not on the website of the node that took them":
    TASK_COPY,
  "receivedDerivation.integration.test.ts > what a node records of a bundle it took (batch 4b) > a mirror client is told the same by the node that wrote and by the node that took the writes (random writes of every table, a tagged paragraph, a task line)":
    TASK_COPY,
  "stampedBundle.integration.test.ts > what a body written on one node derives there, and what a node that takes it by bundle derives (item by item; equal ones are plain tests, differing ones are it.fails: links and block refs turned around in batch 4a, domain events in batch 4b) > *":
    { ...TASK_COPY, why: `${TASK_COPY.why}; the describe builds one world in whichever of its tests runs first (a module-level memo, \`probe\`): that test has the ending` },
  "stampedFieldCopyOfCreation.integration.test.ts > a paragraph row made with its task in one transaction: the writer keeps a copy of the creation stamp for `task`, the receiver does not > what differs today: A holds `*` and `task` under one (origin, number), B only `*`; the full resend stores nothing":
    { ...TASK_COPY, why: `${TASK_COPY.why}; this test asserts that difference itself` },
};

// Tests meant to leave the nodes different (a bundle forged in a sender's name, a session's rows that stay on their node, a clock ahead, a node restored from a backup,
// a planted bug), or that take what no node of the test sent. Say why.
// ratchet:list stamped-ending-skipped
export const ENDING_SKIPPED: Record<string, string> = {
  "bundleNaturalKeys.integration.test.ts > two rows with one natural key, made on two nodes: the earlier stays on both, the report names it > a clash on a unique key no source declares refuses the bundle (bundle_unique_clash) and writes nothing":
    "the test adds, on B only, a unique index no source declares (as a later migration could), so every bundle from A is refused (bundle_unique_clash): the nodes are meant to stay apart",
  "bundleReceivedChecks.integration.test.ts > a received value of any carried table is checked, every head of it too > a value beyond a writer's cap that the database holds (a title of 501 characters), winner or head: taken, and taking it again stores nothing":
    "the test hands the receiver a bundle it changed by hand in the sender's name (a value no honest node writes): the two nodes are meant to disagree about that write",
  "bundleReceivedChecks.integration.test.ts > a value no column of its type can hold, for every unit of every carried table: a coded refusal, never a raw database error > each type: a date that is no day, a number out of range, a boolean that is none, an id that is none, an incompressible text of 300,000 characters; as a winner, a head and a new row":
    "the test hands the receiver a bundle it changed by hand in the sender's name (a value no honest node writes): the two nodes are meant to disagree about that write",
  "bundleReceivedChecks.integration.test.ts > received anchors and paragraph rows are checked before anything is written > a value the database refuses while the anchor rows are written from the unit: bundle_malformed, nothing written":
    "the test adds, on B only, a CHECK that refuses an anchor's edited quote, so every bundle carrying it is refused (bundle_malformed): the nodes are meant to stay apart",
  "mergeSpaceParent.integration.test.ts > a note's space follows its tree (migration 218) > a check the database runs at COMMIT that a bundle would break is a coded refusal with a plain reason, and nothing of the bundle is written":
    "the test adds, on B only, a deferred trigger that refuses every note row a bundle writes, so every bundle from A is refused (bundle_malformed): the nodes are meant to stay apart",
  "nodeRenewal.integration.test.ts > a database restored from a backup takes a new node id > a new origin numbered from 1; nothing it holds is rewritten; the clock is not behind any stamp; the old id becomes an origin it holds":
    "a node restored from a backup sends under the id it had before (the receiver refuses it, bundle_own_origin_ahead, as it should): the nodes are meant to differ until it renews",
  "nodeRenewal.integration.test.ts > a restored and renewed node seen by others (the change-bundle code as it is) > before the renewal the restored node refuses to send (bundle_sender_restored); after it, the peer that joined it refuses the new id (bundle_unknown_sender: it was never admitted)":
    "a node restored from a backup sends under the id it had before (the receiver refuses it, bundle_own_origin_ahead, as it should): the nodes are meant to differ until it renews",
  "nodeRenewal.integration.test.ts > a restored and renewed node seen by others (the change-bundle code as it is) > the peer's copies of the old id's writes the restore lost come back: the restored node takes them as another origin's (no bundle_own_origin_ahead)":
    "a node restored from a backup sends under the id it had before (the receiver refuses it, bundle_own_origin_ahead, as it should): the nodes are meant to differ until it renews",
  "receivedDerivation.integration.test.ts > what a node derives from a bundle it took (batch 4a) > P1 sees a replicated write: a derivation that runs the replicated half of a body write again (blockNodes.ts syncBlockNodes, as a node would if it ran the whole local chain) is caught":
    "a wrong derivation run on the receiver on purpose (it writes a paragraph's tag mark the sender never wrote), to show the check sees it: the nodes are meant to differ",
  "sessionsStayOnTheirNode.integration.test.ts > nothing of a temporary session leaves the node it was opened on > a session that ran out: its membership is cleared by the next opening (the way the product does), and still nothing of it reaches B":
    "a temporary session's rows stay on the node it was opened on, on purpose: that node holds a membership stamp the other never gets",
  "sessionsStayOnTheirNode.integration.test.ts > nothing of a temporary session leaves the node it was opened on > a session that still lives: the same (its rows are out of the scope of what a bundle carries)":
    "a temporary session's rows stay on the node it was opened on, on purpose: that node holds a membership stamp the other never gets",
  "sessionsStayOnTheirNode.integration.test.ts > nothing of a temporary session leaves the node it was opened on > an ended session: B holds its note and the stamps of its writes, and nothing of the session itself":
    "a temporary session's rows stay on the node it was opened on, on purpose: that node holds a membership stamp the other never gets",
  "sessionsStayOnTheirNode.integration.test.ts > nothing of a temporary session leaves the node it was opened on > on the wire: neither a snapshot nor a bundle (nor a digest) carries the session's id anywhere but as the author of a stamp, and the digests of the two nodes agree":
    "a temporary session's rows stay on the node it was opened on, on purpose: that node holds a membership stamp the other never gets",
  "stampSaw.integration.test.ts > what a stamp says its writer had seen > the unit-level reader and writer > a merged move is not written to the structure log (kept as it is: the log is this device's own history, and a line for a change from another device is for batch 2b)":
    "the test merges units it wrote by hand (mergeUnitsIntoWorkspace), from no node: there is no other node to end anything with",
  "stampSaw.integration.test.ts > what a stamp says its writer had seen > the unit-level reader and writer > a value from before stamps survives a write that was made over a different value (it never saw it)":
    "the test merges units it wrote by hand (mergeUnitsIntoWorkspace), from no node: there is no other node to end anything with",
  "stampSaw.integration.test.ts > what a stamp says its writer had seen > the unit-level reader and writer > a write whose clock is ahead of ours waits: nothing is stored, and the report names it":
    "the test merges units it wrote by hand (mergeUnitsIntoWorkspace), from no node: there is no other node to end anything with",
  "stampSaw.integration.test.ts > what a stamp says its writer had seen > the unit-level reader and writer > the same write number with another content is refused and nothing changes":
    "the test merges units it wrote by hand (mergeUnitsIntoWorkspace), from no node: there is no other node to end anything with",
  "stampSaw.integration.test.ts > what a stamp says its writer had seen > the unit-level reader and writer > the writes of a merge are not stamped again, and are counted":
    "the test merges units it wrote by hand (mergeUnitsIntoWorkspace), from no node: there is no other node to end anything with",
  "stampSaw.integration.test.ts > what a stamp says its writer had seen > the unit-level reader and writer > two writes that never saw each other: the larger stamp is the value, the other is kept with its value, and one person's write replaces both":
    "the test merges units it wrote by hand (mergeUnitsIntoWorkspace), from no node: there is no other node to end anything with",
  "stampedBundle.integration.test.ts > change bundles between two nodes > a clock 30 minutes ahead: the bundle is refused whole and offered again, and is taken once the receiver's clock has caught up":
    "the sender's stamps are 30 minutes ahead of the receiver's clock and are refused until it catches up (stamp_clock_ahead): the test does not wait half an hour",
  "stampedBundle.integration.test.ts > what a bundle refuses, whole, with nothing written > the same (origin, seq) with other content: a node restored from a backup made its stamps again (the bundle that shows it is refused); a node told it was ahead of what it ever made is refused too":
    "a node restored from a backup made its stamps again under its old id: the receiver refuses it (bundle_own_origin_ahead), as it should, until a new id (nodeRenewal)",
  "stampedBundle.integration.test.ts > what bundle_stamp_clash cannot see (pinned: the gap a later batch's new node id after a restore has to close) > a restored node's stamp that the receiver has since overwritten is NOT refused: the receiver holds only the newer write, and the older stamp (origin, seq) is no longer there to compare":
    "a node restored from a backup made its stamps again under its old id, the gap that test pins itself (it.fails there): the nodes are meant to differ",
  "stampedBundle.integration.test.ts > writes that cannot be sent: the refusal, the numbers, and the state a screen can read > a clock that was 30 minutes ahead and is set right again still holds: the writes made after it carry the stored clock, the refusal says both numbers, and the state counts the writes":
    "the sender's stamps are 30 minutes ahead of the receiver's clock and are refused until it catches up (stamp_clock_ahead): the test does not wait half an hour",
  "stampedBundlePlanted.integration.test.ts > the receive side catches a planted bug > PLANTED fresh road (PR #1853 round 7, item 1): the write-back skips clearing the heads this node already holds; an exchange fails or the nodes differ":
    "a bug planted on purpose in the receive side: the nodes are meant to differ (the test asserts that they do)",
  "stampedBundleTwoProcess.integration.test.ts > change bundles between three processes > A↔B and A↔C, twice: the same digest in all three; a bundle twice changes nothing; a sender nobody admitted is refused":
    "the exchanges happen in three worker processes, each with its own database (helpers/stampedBundleWorker.ts): this process cannot reach them to end them; the test itself compares the digests of all three after exchanging twice",
  "stampedSnapshotTwoProcess.integration.test.ts > (outside a test)":
    "the snapshot is made and taken in two worker processes, each with its own database (helpers/stampedTwoProcessWorker.ts), in the file's beforeAll: this process cannot reach them; the tests compare what the receiver holds row by row and hashed",
  "syncSystemWriteConflict.integration.test.ts > a system write beside a conflict > is refused while the unit holds another head, with a retryable code, and changes nothing; a person's write resolves it; then the system may write":
    "the test merges units it wrote by hand (mergeUnitsIntoWorkspace), from no node: there is no other node to end anything with",
};

// Tests whose own exchanges leave so much undelivered that the ending needs more rounds to settle than the group's widest gap calls for (a write crosses one pair a round:
// two nodes settle in 2 rounds, a chain of three in 3). More is a merge that answers its own merge (helpers/stampedEnding.ts settle). Say why, with the rounds it takes.
// ratchet:list stamped-ending-long-settle
export const ENDING_LONG_SETTLE: Record<string, string> = {
};

// Test files that mock spine/stampedImport.ts themselves, which replaces the recording wrapper of test/stampedEndingSetup.ts for the whole file
// (guards/stampedEndingReach.guard.test.ts). Such a file records its calls by itself or ends nothing: say which.
// ratchet:list stamped-ending-own-mocks
export const ENDING_OWN_MOCKS: Record<string, string> = {
  "stampedEndingControl.integration.test.ts": "the negative control: its double of applyChangeBundle records every call through engineCall, as the wrapper does",
};
