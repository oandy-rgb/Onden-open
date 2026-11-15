import type { ContentNode } from "../lib/api";
import { useVersionHistoryDialog, type NodeVersion } from "../components/NoteVersionHistory";

/** A stand-in opener for the note history dialog: a button per recent save and one for all of them.
 *  The screens that open it in the app (the note header, the ⋯ menu) call the same hook. */
export default function VersionHistoryHarness({ node, nodeVersions, onSelectNode }: {
  node: ContentNode;
  nodeVersions: NodeVersion[];
  onSelectNode: (id: string) => void;
}) {
  const { openHistory, dialog } = useVersionHistoryDialog({ node, nodeVersions, onSelectNode });
  return (
    <div>
      <button onClick={() => openHistory()}>All versions</button>
      {nodeVersions.slice(0, 3).map((v) => (
        <button key={v.id} onClick={() => openHistory(v.id)}>{v.actor_name || "Unknown author"} {v.saves ?? 1} {(v.saves ?? 1) === 1 ? "save" : "saves"}</button>
      ))}
      {dialog}
    </div>
  );
}
