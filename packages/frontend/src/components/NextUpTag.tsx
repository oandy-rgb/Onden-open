// 「接下來」: a small tag in the top bar with the next timed thing today —
// "15:00 Call the bank · in 40 min". It opens the Tasks page, where the day's
// timeline is (owner 2026-11-10: 「應該是到任務頁」); nothing to show, the tasks
// module off, or already on that page, and it is not there.

import { Clock } from "lucide-react";
import { useTasksEnabled } from "../hooks/useModuleFilter";
import { useNextUp } from "../hooks/useNextUp";
import { clockLabel } from "../lib/dayWindow";
import { useT } from "../lib/i18n";
import { Pressable } from "./ui";

export default function NextUpTag({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const enabled = useTasksEnabled();
  const next = useNextUp();
  if (!enabled || !next || !next.item.at) return null;
  const when = next.minutes < 60 ? t("in {n} min", { n: next.minutes }) : t("in {n} h", { n: Math.round(next.minutes / 60) });
  return (
    <Pressable type="button" className="topbar-next-up topbar-desktop-only" onClick={onOpen} title={t("Go to Tasks")}>
      <Clock size={13} aria-hidden="true" />
      <span className="topbar-next-up-text">{clockLabel(next.item.at)} {next.item.title} · {when}</span>
    </Pressable>
  );
}
