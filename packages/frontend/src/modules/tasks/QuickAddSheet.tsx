// Quick-add task as a sheet (a bottom sheet on a phone, a centred card on desktop): QuickAddPanel in a Sheet.
// The 日子 timeline draws the same panel in its own popover / sheet (modules/daily TimelinePlanner).

import { useState } from "react";
import { Sheet } from "../../components/ui";
import { t } from "../../lib/i18n";
import QuickAddPanel from "./QuickAddPanel";
import type { QuickAddTarget } from "./openQuickAddTask";

export default function QuickAddSheet({ into = null, onClose }: { into?: QuickAddTarget | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet label={t("Add a task")} className="quick-add-overlay" busy={busy} onClose={onClose} cardClassName="quick-add-sheet">
      <QuickAddPanel into={into} onClose={onClose} onBusyChange={setBusy} />
    </Sheet>
  );
}
