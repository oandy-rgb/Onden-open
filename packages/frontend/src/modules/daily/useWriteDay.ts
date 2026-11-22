// 「寫點什麼…」 on a day: open that day's note to write in, starting it first when there is none
// (dayNotes.openDay, the single entry that makes a day note; lib/data/dayNotes.ts). The Journal page starts
// a day this way.

import { useState } from "react";
import { addToast } from "../../lib/appStore";
import { dayNotes, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";

export function useWriteDay(existing: (date: string) => { id: string } | undefined, onOpenNode: (id: string) => void) {
  const t = useT();
  const [starting, setStarting] = useState(false);
  async function writeDay(date: string) {
    const found = existing(date);
    if (found) { onOpenNode(found.id); return; }
    if (starting) return;
    setStarting(true);
    try {
      const opened = await dayNotes.openDay(date);
      if (opened) {
        if (opened.created) addToast(t('"{title}" created', { title: opened.node.title }), "success");
        onOpenNode(opened.node.id);
      }
    } catch (error) {
      writeErrors.report(error, addToast);
    } finally {
      setStarting(false);
    }
  }
  return { writeDay, starting };
}
