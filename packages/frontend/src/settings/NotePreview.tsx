import { PreviewBlock } from "../components/ui";
import { useT } from "../lib/i18n";

// Settings › Notes: the page's one preview, a note drawn with the same variables a real note page
// reads (font, text size, width), so each control below changes it as it is moved. It shows
// nothing the controls do not set.
export default function NotePreview() {
  const t = useT();
  return (
    <PreviewBlock label={t("Preview")} className="note-preview">
      <div className="note-preview-page">
        <p className="note-preview-title">{t("A quiet morning")}</p>
        <p className="note-preview-body">{t("The words you write look like this on every page. 中文與 English 混著寫也一樣整齊。")}</p>
        <ul className="note-preview-list">
          <li>{t("Buy tea")}</li>
          <li>{t("Call 阿姨 on Sunday")}</li>
        </ul>
      </div>
    </PreviewBlock>
  );
}
