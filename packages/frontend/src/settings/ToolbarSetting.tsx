import { useState } from "react";
import { Button } from "../components/ui";
import { ToolbarLayoutEditor } from "../components/ToolbarLayoutEditor";
import { useT } from "../lib/i18n";
import { takeToolbarEditorRequest } from "../lib/toolbarEditorRequest";

// Settings › Notes › 工具列: which buttons the editor's toolbars show, and in what
// order (components/ToolbarLayoutEditor; the rules are lib/toolbarLayout's). Folded until
// asked for, since it is rarely changed; the toolbars' 「編輯工具列…」 opens it unfolded.
export default function ToolbarSetting() {
  const t = useT();
  const [open, setOpen] = useState(takeToolbarEditorRequest);
  return (
    <div className="settings-section nav-settings">
      {open ? <ToolbarLayoutEditor /> : (
        <Button variant="secondary" aria-expanded={false} onClick={() => setOpen(true)}>{t("Edit the toolbar…")}</Button>
      )}
    </div>
  );
}
