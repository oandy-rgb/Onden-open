import { FileText, Folder, Plus } from "lucide-react";
import { Button, PreviewBlock } from "../components/ui";
import { useT } from "../lib/i18n";
import "./AppearancePreview.css";

// Settings › Appearance: the page's one preview, a small app (list rows, a selected row, a button)
// drawn with the real tokens, so the theme, the colours and the interface size change it as they
// are chosen. (The notes' own text is Settings › Notes.)
export default function AppearancePreview() {
  const t = useT();
  return (
    <PreviewBlock label={t("Preview")} className="appearance-preview">
      <div className="appearance-preview-app" aria-hidden="true">
        <div className="appearance-preview-row"><Folder size={14} />{t("Projects")}</div>
        <div className="appearance-preview-row appearance-preview-row--selected"><FileText size={14} />{t("A quiet morning")}</div>
        <div className="appearance-preview-row"><FileText size={14} />{t("Reading list")}</div>
        <Button variant="primary" size="sm" tabIndex={-1}><Plus size={14} />{t("New note")}</Button>
      </div>
    </PreviewBlock>
  );
}
