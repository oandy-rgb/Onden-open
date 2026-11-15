import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { readSkillSettings } from "@onden/markdown";
import { useTagRows } from "../../lib/appStore";
import { useT } from "../../lib/i18n";
import { onEnter } from "../../lib/keys";
import { listsInTagTree } from "../../lib/tagTree";
import type { NoteHeaderActionProps } from "../types";
import { Button, Chip, Switch, TextField } from "../../components/ui";
import PickMenu from "./PickMenu";
import { changeSkill } from "./changeSkill";
import "./skills.css";

/** The skill's fields in the info panel, under 「當成技能」 once it is on:
 *  when to use it, the tags it is for, and whether the AI may pick it itself.
 *  They are the note's own settings (changeSkill writes the note's text), so
 *  the skills page and a tag page show and change the same ones. */
export default function SkillNoteFields({ node }: NoteHeaderActionProps) {
  const t = useT();
  const tags = useTagRows();
  const settings = useMemo(() => readSkillSettings(node.markdown ?? ""), [node.markdown]);
  const [when, setWhen] = useState(settings.description);
  // The note changed under us (a save, another device): show its text.
  useEffect(() => setWhen(settings.description), [settings.description]);

  const applied = new Set(settings.appliesTo.map((name) => name.toLowerCase()));
  const options = (tags ?? [])
    .filter((tag) => listsInTagTree(tag) && !tag.schema_module && !applied.has(tag.name.toLowerCase()))
    .map((tag) => ({ key: tag.name, label: `#${tag.name}` }));

  const saveWhen = () => { if (when.trim() !== settings.description) void changeSkill(node.id, { description: when }); };
  const setApplies = (names: string[]) => void changeSkill(node.id, { appliesTo: names });

  return (
    <div className="skill-fields">
      <label className="skill-field">
        <span className="skill-field-label">{t("When to use it")}</span>
        <TextField className="ui-text-field" value={when} placeholder={t("e.g. when I ask for a summary of a paper")}
          onChange={(event) => setWhen(event.target.value)} onBlur={saveWhen}
          onKeyDown={onEnter((event) => event.currentTarget.blur())} />
      </label>
      <div className="skill-field">
        <span className="skill-field-label">{t("Applies to")}</span>
        <div className="skill-tags">
          {settings.appliesTo.length === 0 && <span className="skill-field-hint">{t("Any note")}</span>}
          {settings.appliesTo.map((name) => (
            <Chip key={name} className="skill-tag-item">
              #{name}
              <Button size="sm" variant="icon" aria-label={t("Remove {name}", { name: `#${name}` })}
                onClick={() => setApplies(settings.appliesTo.filter((other) => other !== name))}><X size={12} aria-hidden="true" /></Button>
            </Chip>
          ))}
          <PickMenu label={t("Add a tag")} options={options} empty={t("No more tags to add")}
            onPick={(name) => setApplies([...settings.appliesTo, name])} />
        </div>
      </div>
      <div className="skill-field skill-field--switch">
        <span className="skill-field-text">
          <span className="skill-field-label">{t("Let the AI use it")}</span>
          <span className="skill-field-hint">{t("The AI uses it by itself when it fits")}</span>
        </span>
        <Switch on={settings.ai === "auto"} label={t("Let the AI use it")}
          onChange={(on) => void changeSkill(node.id, { ai: on ? "auto" : "manual" })} />
      </div>
    </div>
  );
}
