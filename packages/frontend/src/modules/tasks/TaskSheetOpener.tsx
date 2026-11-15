// One task's sheet outside the Tasks page: the board's list and actions, the same TaskSheet.
import { useEffect } from "react";
import { addToast } from "../../lib/appStore";
import { useT } from "../../lib/i18n";
import TaskSheet from "./TaskSheet";
import { useTaskBoard } from "./useTaskBoard";

type Props = {
  taskId: string;
  online: boolean;
  onSelectNode: (id: string) => void;
  onRefresh: () => void;
  onError: (message: string) => void;
  onClose: () => void;
};

export default function TaskSheetOpener({ taskId, onClose, ...board }: Props) {
  const t = useT();
  const { items, today, notes, actions } = useTaskBoard(board);
  const task = items.find((item) => item.id === taskId) ?? null;
  useEffect(() => {
    if (task) return;
    addToast(t("We can’t find this task"), "info");
    onClose();
  }, [task]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!task) return null;
  return <TaskSheet key={task.id} task={task} today={today} notes={notes} actions={actions} onClose={onClose} />;
}
