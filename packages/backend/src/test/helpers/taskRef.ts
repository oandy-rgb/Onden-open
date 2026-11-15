// Make a node a task node the way production does (spine/taskIdentity.ts): it references the tasks function.
// A task also needs a `_task_status` attribute to count as one. `seedQ`: fixtures write outside the app's transactions.
import { seedQ } from "./seedQ.js";

export async function markAsTask(workspaceId: string, nodeId: string): Promise<void> {
  await seedQ(
    `INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'tasks', $2) ON CONFLICT DO NOTHING`,
    [workspaceId, nodeId],
  );
}
