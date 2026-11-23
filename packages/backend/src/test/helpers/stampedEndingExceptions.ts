// The tests of bundles whose ending (helpers/stampedEnding.ts: one more exchange round between every pair and a full resend, nothing stored, nothing refused,
// the same stamps, heads and values on every node) is not run as it is for every other test. The key is "file > describe > … > test" as vitest names it.
// `fails`: a FINDING, pinned: the ending must still fail (when it passes, the run fails and asks for the entry and its README line to go); each has a line under
// 「接上傳輸前必須完成」 in spine/stampedMerge/README.md. `skipped`: the test is about nodes that must NOT end the same (say why).
// Shrink-only (scripts/ratchetLib.mjs, `npm run ratchet:check`).
export type EndingException = { ending: "fails" | "skipped"; why: string };
// ratchet:list stamped-ending-exceptions
export const ENDING_EXCEPTIONS: Record<string, EndingException> = {
  "anchorsReplicated.integration.test.ts > a body write's anchors, paragraph rows and task notes on three nodes > round 10, 4 (stamps): what differs today: B keeps a stamp row of K's parent holding P's id, A none":
    { ending: "fails", why: "README 接上傳輸前必須完成: 外鍵清空的欄位，被指的那一列之後以同一個 id 再建 (B keeps a parent stamp A has not)" },
  "bundleNaturalKeys.integration.test.ts > two rows with one natural key, made on two nodes: the earlier stays on both, the report names it > a clash on a unique key no source declares refuses the bundle (bundle_unique_clash) and writes nothing":
    { ending: "skipped", why: "the test makes two rows clash on a unique key no source declares, so that every bundle is refused (bundle_unique_clash): the nodes are meant to stay apart" },
  "bundleReceivedChecks.integration.test.ts > a received value of any carried table is checked, every head of it too > a value beyond a writer's cap that the database holds (a title of 501 characters), winner or head: taken, and taking it again stores nothing":
    { ending: "skipped", why: "the test hands the receiver a bundle it changed by hand in the sender's name (a value no honest node writes): the two nodes are meant to disagree about that write" },
  "bundleReceivedChecks.integration.test.ts > a value no column of its type can hold, for every unit of every carried table: a coded refusal, never a raw database error > each type: a date that is no day, a number out of range, a boolean that is none, an id that is none, an incompressible text of 300,000 characters; as a winner, a head and a new row":
    { ending: "skipped", why: "the test hands the receiver a bundle it changed by hand in the sender's name (a value no honest node writes): the two nodes are meant to disagree about that write" },
  "bundleReceivedChecks.integration.test.ts > received anchors and paragraph rows are checked before anything is written > a value the database refuses while the anchor rows are written from the unit: bundle_malformed, nothing written":
    { ending: "skipped", why: "the test hands the receiver a bundle it changed by hand in the sender's name (a value no honest node writes): the two nodes are meant to disagree about that write" },
  "mergeSpaceParent.integration.test.ts > a note's space follows its tree (migration 218) > a check the database runs at COMMIT that a bundle would break is a coded refusal with a plain reason, and nothing of the bundle is written":
    { ending: "skipped", why: "the test hands the receiver a bundle it changed by hand in the sender's name (a state the database's check at COMMIT refuses): the two nodes are meant to disagree about that write" },
  "receivedDerivation.integration.test.ts > what a node derives from a bundle it took (batch 4a) > P1 sees a replicated write: a derivation that runs the replicated half of a body write again (blockNodes.ts syncBlockNodes, as a node would if it ran the whole local chain) is caught":
    { ending: "skipped", why: "a wrong derivation run on the receiver on purpose (it writes a paragraph's tag mark the sender never wrote), to show the check sees it: the nodes are meant to differ" },
  "sessionsStayOnTheirNode.integration.test.ts > nothing of a temporary session leaves the node it was opened on > a session that ran out: its membership is cleared by the next opening (the way the product does), and still nothing of it reaches B":
    { ending: "skipped", why: "a temporary session's rows stay on the node it was opened on, on purpose: that node holds a membership stamp the other never gets" },
  "sessionsStayOnTheirNode.integration.test.ts > nothing of a temporary session leaves the node it was opened on > a session that still lives: the same (its rows are out of the scope of what a bundle carries)":
    { ending: "skipped", why: "a temporary session's rows stay on the node it was opened on, on purpose: that node holds a membership stamp the other never gets" },
  "sessionsStayOnTheirNode.integration.test.ts > nothing of a temporary session leaves the node it was opened on > an ended session: B holds its note and the stamps of its writes, and nothing of the session itself":
    { ending: "skipped", why: "a temporary session's rows stay on the node it was opened on, on purpose: that node holds a membership stamp the other never gets" },
  "sessionsStayOnTheirNode.integration.test.ts > nothing of a temporary session leaves the node it was opened on > on the wire: neither a snapshot nor a bundle (nor a digest) carries the session's id anywhere but as the author of a stamp, and the digests of the two nodes agree":
    { ending: "skipped", why: "a temporary session's rows stay on the node it was opened on, on purpose: that node holds a membership stamp the other never gets" },
  "stampedBundle.integration.test.ts > change bundles between two nodes > a clock 30 minutes ahead: the bundle is refused whole and offered again, and is taken once the receiver's clock has caught up":
    { ending: "skipped", why: "the sender's stamps are 30 minutes ahead of the receiver's clock and are refused until it catches up (stamp_clock_ahead): the test does not wait half an hour" },
  "stampedBundle.integration.test.ts > what a bundle refuses, whole, with nothing written > the same (origin, seq) with other content: a node restored from a backup made its stamps again (the bundle that shows it is refused); a node told it was ahead of what it ever made is refused too":
    { ending: "skipped", why: "a node restored from a backup made its stamps again under its old id: the receiver refuses it (bundle_own_origin_ahead), as it should, until a new id (nodeRenewal)" },
  "stampedBundle.integration.test.ts > what bundle_stamp_clash cannot see (pinned: the gap a later batch's new node id after a restore has to close) > a restored node's stamp that the receiver has since overwritten is NOT refused: the receiver holds only the newer write, and the older stamp (origin, seq) is no longer there to compare":
    { ending: "skipped", why: "a node restored from a backup made its stamps again under its old id, the gap that test pins itself (it.fails there): the nodes are meant to differ" },
  "stampedBundle.integration.test.ts > writes that cannot be sent: the refusal, the numbers, and the state a screen can read > a clock that was 30 minutes ahead and is set right again still holds: the writes made after it carry the stored clock, the refusal says both numbers, and the state counts the writes":
    { ending: "skipped", why: "the sender's stamps are 30 minutes ahead of the receiver's clock and are refused until it catches up (stamp_clock_ahead): the test does not wait half an hour" },
  "stampedBundlePlanted.integration.test.ts > a note purged and made again under its id on A, after A and B each undid its trash > what the two nodes hold now (the finding, named): every exchange taken, none refused, and B keeps its undo as a head of X's `deleted` that A does not hold":
    { ending: "fails", why: "README 接上傳輸前必須完成: 永久刪除後以同一個 id 再建，對上另一台已被結掉的 `deleted` 頭 (a full resend stores 1)" },
  "stampedBundlePlanted.integration.test.ts > the receive side catches a planted bug > PLANTED fresh road (PR #1853 round 7, item 1): the write-back skips clearing the heads this node already holds; an exchange fails or the nodes differ":
    { ending: "skipped", why: "a bug planted on purpose in the receive side: the nodes are meant to differ (the test asserts that they do)" },
  "stampedCardTwiceOnPurgedNote.integration.test.ts > a card two nodes placed on their own, on a note a third deleted for good > a day's note made again under its id: what differs today (A and C hold D without the card, B with it and its field unit)":
    { ending: "fails", why: "README 接上傳輸前必須完成: 筆記以同一個 id 重建時，掛在它上面的列在沒握有它的節點永遠回不來 (a full resend stores 6)" },
};
