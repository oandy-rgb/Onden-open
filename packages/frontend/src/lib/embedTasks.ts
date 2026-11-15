import { taskWriter } from "./data";

/** The checkbox of an embedded task (`![[task]]`): the ordinary task write, so it queues offline like any other. */
export function setEmbeddedTaskDone(taskId: string, done: boolean): void {
  void taskWriter.patch(taskId, { status: done ? "done" : "todo" });
}
