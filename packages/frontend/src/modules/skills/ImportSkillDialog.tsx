// 「匯入 SKILL.md」: paste a SKILL.md or choose the file, check what Onden will
// take from it, then create the skill note (createSkillNote). Onden runs no
// third-party code, so only the text comes in: scripts and extra files named
// in the body are not imported, and the dialog says so before it creates.
// A .zip is not read (no zip reader in the app): choose the SKILL.md inside.
import { useRef, useState } from "react";
import { parseSkillMd, SkillMdError, type ParsedSkillMd } from "@onden/markdown";
import ShellDialog from "../../components/ShellDialog";
import { Button, FieldError, FileInput, TextArea } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { useCreateSkillNote } from "../../lib/createSkillNote";
import "./skills.css";

const MAX_FILE_BYTES = 1_000_000;

/** `onOpenNode`: show the created skill so the person can edit it. */
export default function ImportSkillDialog({ onClose, onOpenNode }: { onClose: () => void; onOpenNode?: (id: string) => void }) {
  const t = useT();
  const skills = useCreateSkillNote(onOpenNode);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedSkillMd | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (/\.zip$/i.test(file.name) || file.type === "application/zip") {
      setError(t("A .zip can't be read here. Choose the SKILL.md inside it, or paste its text."));
      return;
    }
    if (file.size > MAX_FILE_BYTES) { setError(t("That file is too large to be a SKILL.md.")); return; }
    try { setText(await file.text()); } catch { setError(t("Couldn't read that file.")); }
  }

  function check() {
    setError(null);
    try { setParsed(parseSkillMd(text)); }
    catch (e) { setError(e instanceof SkillMdError ? t("The SKILL.md has no instructions.") : t("Couldn't read that SKILL.md.")); }
  }

  async function create(skill: ParsedSkillMd) {
    setBusy(true);
    try {
      const { ignoredKeys: _ignored, bundledFiles: _bundled, ...input } = skill;
      if (await skills.create(input)) onClose();
    } finally { setBusy(false); }
  }

  return (
    <ShellDialog label={t("Import SKILL.md")} className="skill-run" busy={busy} onClose={onClose}>
      <h2 className="skill-run-title">{t("Import SKILL.md")}</h2>
      {!parsed ? (
        <>
          <label className="skill-import-field">
            <span>{t("Paste the SKILL.md text")}</span>
            <TextArea className="skill-import-text" value={text} rows={10} spellCheck={false}
              onChange={(e) => { setText(e.target.value); setError(null); }} />
          </label>
          <FileInput ref={fileInput} accept=".md,.markdown,.txt,text/markdown,text/plain,.zip" hidden
            onChange={(e) => { void chooseFile(e.target.files?.[0]); e.target.value = ""; }} />
          {error && <FieldError>{error}</FieldError>}
          <div className="skill-run-actions">
            <Button onClick={() => fileInput.current?.click()}>{t("Choose a file…")}</Button>
            <Button onClick={onClose}>{t("Cancel")}</Button>
            <Button variant="primary" disabled={!text.trim()} onClick={check}>{t("Continue")}</Button>
          </div>
        </>
      ) : (
        <>
          <p className="skill-run-name">{parsed.title}</p>
          {parsed.description && <p className="skill-run-hint">{parsed.description}</p>}
          <pre className="skill-run-result">{parsed.instructions}</pre>
          {parsed.ignoredKeys.length > 0 && (
            <p className="skill-run-hint" role="note">{t("Not imported (Onden doesn't use these): {keys}", { keys: parsed.ignoredKeys.join(", ") })}</p>
          )}
          {parsed.bundledFiles && (
            <p className="skill-run-hint" role="note">{t("This skill mentions scripts or other files. Bundled files and scripts are not imported, only the text; Onden doesn't run third-party code.")}</p>
          )}
          <p className="skill-run-hint">{t("It is saved as a skill note where new notes go. Onden does not run it: your own AI uses it through MCP, and only in spaces that let AI read notes.")}</p>
          <div className="skill-run-actions">
            <Button disabled={busy} onClick={() => setParsed(null)}>{t("Back")}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void create(parsed)}>{t("Import skill")}</Button>
          </div>
        </>
      )}
    </ShellDialog>
  );
}
