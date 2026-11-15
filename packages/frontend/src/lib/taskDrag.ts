// A task card dragged to a place that plans it: the week board's day columns
// and the timeline's hours. One drag type and one pair of helpers, so both
// agree on what is carried (the task's id).

export const TASK_DRAG_TYPE = "text/x-onden-task";

/** Props that make an element a drag source for the task. */
export const taskDragSource = (id: string) => ({
  draggable: true,
  onDragStart: (event: React.DragEvent) => { event.dataTransfer.setData(TASK_DRAG_TYPE, id); event.dataTransfer.effectAllowed = "move"; },
});

/** Whether a drag in progress carries a task (readable while dragging; the id is not). */
export const dragCarriesTask = (event: React.DragEvent): boolean => Array.from(event.dataTransfer.types ?? []).includes(TASK_DRAG_TYPE);

/** The id of the task dropped, or "". */
export const droppedTaskId = (event: React.DragEvent): string => event.dataTransfer.getData(TASK_DRAG_TYPE);
