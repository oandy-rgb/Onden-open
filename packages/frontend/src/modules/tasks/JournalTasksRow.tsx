// One task line in the journal. Props are the shape components/tasks/TaskRow
// takes (title, done, tonight, onToggle, trailing), so TaskRow can replace this
// file's row once it lands; until then the journal does not depend on it.

import { Pressable } from "../../components/ui";
import type { ReactNode } from "react";
import { Button } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import "./JournalTasks.css";

export type JournalTasksRowProps = {
  title: string;
  done: boolean;
  /** Shows the purple 「今晚」 chip. */
  tonight?: boolean;
  onToggle: () => void;
  /** A second, quieter line under the title (the time, the note it sits in). */
  detail?: string;
  /** Makes the title a button (open the task's note). */
  onOpen?: () => void;
  /** Right-hand actions (the suggestions' two buttons). */
  trailing?: ReactNode;
};

export default function JournalTasksRow({ title, done, tonight, onToggle, detail, onOpen, trailing }: JournalTasksRowProps) {
  const t = useT();
  return (
    <div className={`journal-task${done ? " is-done" : ""}`}>
      <Pressable type="button" className="journal-task-check" role="checkbox" aria-checked={done}
        aria-label={done ? t("Mark \"{title}\" as not done", { title }) : t("Mark \"{title}\" as done", { title })} onClick={onToggle} />
      {(() => {
        const text = (
          <>
            <span className="journal-task-title">{displayTitle(title)}</span>
            {detail && <span className="journal-task-detail">{detail}</span>}
          </>
        );
        return onOpen
          ? <Button variant="ghost" className="journal-task-text" onClick={onOpen}>{text}</Button>
          : <span className="journal-task-text">{text}</span>;
      })()}
      {tonight && <span className="journal-task-tonight">{t("Tonight")}</span>}
      {trailing && <span className="journal-task-actions">{trailing}</span>}
    </div>
  );
}
