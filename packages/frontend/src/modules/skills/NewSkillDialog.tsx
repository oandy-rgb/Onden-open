// 「＋ 新增技能」: name, what the AI should do, where the result goes, and
// optionally which tags' notes offer it. Created through useCreateSkillNote
// (the one way a skill note is made), then opened.
import { useId, useState } from "react";
import { SKILL_OUTPUTS } from "@onden/markdown";
import ShellDialog from "../../components/ShellDialog";
import { Button, FieldError, Radio, TextArea, TextField } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { useAppSelector } from "../../lib/appStore";
import { useCreateSkillNote } from "../../lib/createSkillNote";
import type { Tag } from "../../lib/api";
import { tagName } from "../../lib/hashtags";
import "./skills.css";

type Output = (typeof SKILL_OUTPUTS)[number];
const OUTPUT_LABEL: Record<Output, string> = {
  note: "A new note",
  insert: "Insert at the cursor",
  slide: "Slides",
};
const EMPTY_TAGS: Tag[] = [];

/** Comma/、/newline separated tag names, `#` and duplicates dropped. */
export function parseTagNames(text: string): string[] {
  return [...new Set(text.split(/[,，、\n]/).map((n) => tagName(n)).filter(Boolean))];
}

/** `onOpenNode`: show the created skill so the person can finish it there. */
export default function NewSkillDialog({ onClose, onOpenNode, parentId }: { onClose: () => void; onOpenNode?: (id: string) => void; parentId?: string | null }) {
  const t = useT();
  const skills = useCreateSkillNote(onOpenNode, parentId);
  const listId = useId();
  const tags = useAppSelector((s) => s.data.tags ?? EMPTY_TAGS);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [output, setOutput] = useState<Output>("note");
  const [appliesTo, setAppliesTo] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);

  const missingTitle = !title.trim();
  const missingInstructions = !instructions.trim();

  async function create() {
    setTried(true);
    if (missingTitle || missingInstructions) return;
    setBusy(true);
    try {
      const names = parseTagNames(appliesTo);
      const created = await skills.create({
        title: title.trim(),
        instructions: instructions.trim(),
        output,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(names.length ? { appliesTo: names } : {}),
      });
      if (created) onClose();
    } finally { setBusy(false); }
  }

  const suggestions = tags.filter((tag) => !tag.reserved_key).slice(0, 200);

  return (
    <ShellDialog label={t("New skill")} className="skill-run" busy={busy} onClose={onClose}>
      <h2 className="skill-run-title">{t("New skill")}</h2>
      <form className="skill-new-form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label className="skill-import-field">
          <span>{t("Skill name")}</span>
          <TextField className="skill-new-input" value={title} maxLength={200} aria-invalid={tried && missingTitle}
            onChange={(e) => setTitle(e.target.value)} />
          {tried && missingTitle && <FieldError>{t("Give the skill a name.")}</FieldError>}
        </label>
        <label className="skill-import-field">
          <span>{t("Instructions for the AI")}</span>
          <TextArea className="skill-import-text skill-new-instructions" rows={6} value={instructions} aria-invalid={tried && missingInstructions}
            onChange={(e) => setInstructions(e.target.value)} />
          {tried && missingInstructions && <FieldError>{t("Write the instructions for the AI.")}</FieldError>}
        </label>
        <fieldset className="skill-new-output">
          <legend>{t("Where does the result go?")}</legend>
          {SKILL_OUTPUTS.map((value) => (
            <label key={value} className="skill-new-choice tap-target">
              <Radio name="skill-output" checked={output === value} onChange={() => setOutput(value)} />
              {t(OUTPUT_LABEL[value])}
            </label>
          ))}
        </fieldset>
        <label className="skill-import-field">
          <span>{t("Show on notes with these tags (optional)")}</span>
          <TextField className="skill-new-input" list={listId} value={appliesTo} placeholder={t("Tag names, separated by commas")}
            onChange={(e) => setAppliesTo(e.target.value)} />
          <datalist id={listId}>{suggestions.map((tag) => <option key={tag.id} value={tag.name} />)}</datalist>
        </label>
        <label className="skill-import-field">
          <span>{t("One-line description (optional)")}</span>
          <TextField className="skill-new-input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <p className="skill-run-hint">{t("It is saved as a skill note where new notes go. Onden does not run it: your own AI uses it through MCP, and only in spaces that let AI read notes.")}</p>
        <div className="skill-run-actions">
          <Button type="button" disabled={busy} onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{t("Create skill")}</Button>
        </div>
      </form>
    </ShellDialog>
  );
}
