import { useEffect, useMemo } from "react";
import { FileUp, Plus, Sparkles } from "lucide-react";
import { readSkillSettings } from "@onden/markdown";
import type { SettingContext } from "../../lib/settingsTypes";
import { useOnline, useTagRows, useAllNodes } from "../../lib/appStore";
import { useT } from "../../lib/i18n";
import { invalidateQueries } from "../../lib/data";
import { openModuleDialog } from "../../lib/moduleDialog";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { useNoteSkills, type CatalogueSkill } from "../../hooks/useNoteSkills";
import { Button, Switch } from "../../components/ui";
import { BUILTIN_SKILL_TEXT } from "./builtinSkills";
import { aiSkillsOffPref, withBuiltinAi } from "./aiSkillsOffPref";
import { changeSkill } from "./changeSkill";
import "./skills.css";

// Dialogs load on the click (lib/moduleDialog shows them inside a Suspense).
const ImportSkillDialog = lazyWithReload(() => import("./ImportSkillDialog"));
const NewSkillDialog = lazyWithReload(() => import("./NewSkillDialog"));

/** Settings › Features › Skills: the person's skills with each one's
 *  「給 AI 用」 switch (on: the AI uses it by itself when it fits; off: only when
 *  named), the built-in ones, and the two ways to make a skill. The list is the
 *  skill catalogue the server serves; a note skill's switch is read from the
 *  note itself, so a change shows at once. */
export default function SkillsSettings({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const online = useOnline();
  const nodes = useAllNodes();
  const tags = useTagRows();
  const { catalogue, refresh } = useNoteSkills({ autoload: true, online });
  const { value: off, save: saveOff } = aiSkillsOffPref.useValue();
  // The list is read again when a skill was made or imported here.
  useEffect(() => { invalidateQueries("/api/skills"); void refresh(); }, [refresh]);

  const tagName = useMemo(() => new Map((tags ?? []).map((tag) => [tag.id, tag.name])), [tags]);
  const notes = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const mine = (catalogue ?? []).filter((skill) => skill.kind === "note");
  const builtin = (catalogue ?? []).filter((skill) => skill.kind === "builtin");

  const aiUse = (skill: CatalogueSkill) => {
    if (skill.kind === "builtin") return !(off ?? []).includes(skill.id);
    const note = notes.get(skill.id);
    return note?.markdown !== undefined ? readSkillSettings(note.markdown).ai === "auto" : skill.aiUse;
  };
  const subtitle = (skill: CatalogueSkill) => {
    if (!aiUse(skill)) return t("Only when you name it");
    const names = skill.appliesTo?.flatMap((id) => tagName.get(id) ?? []) ?? [];
    return names.length ? t("Applies to {tags}", { tags: names.map((name) => `#${name}`).join(" ") }) : t("Any note");
  };
  const flip = (skill: CatalogueSkill, on: boolean) => {
    if (skill.kind === "builtin") { saveOff(withBuiltinAi(off, skill.id, on)); return; }
    void changeSkill(skill.id, { ai: on ? "auto" : "manual" });
  };
  const open = ctx.openNote;
  const text = (skill: CatalogueSkill) => skill.kind === "builtin" ? BUILTIN_SKILL_TEXT[skill.id] : undefined;

  const row = (skill: CatalogueSkill) => (
    <li key={skill.id} className="skills-row">
      {skill.kind === "note" && open ? (
        <Button variant="ghost" className="skills-row-main" onClick={() => open(skill.id)}>
          <span className="skills-row-name">{skill.name}</span>
          <span className="skills-row-sub">{subtitle(skill)}</span>
        </Button>
      ) : (
        <span className="skills-row-main">
          <span className="skills-row-name">{text(skill)?.name() ?? skill.name}</span>
          <span className="skills-row-sub">{subtitle(skill)}</span>
        </span>
      )}
      <Switch on={aiUse(skill)} label={t("Let the AI use {name}", { name: text(skill)?.name() ?? skill.name })} onChange={(on) => flip(skill, on)} />
    </li>
  );

  return (
    <div className="skills-page">
      <p className="skills-page-lead">{t("The AI uses the ones that are on by itself, when it fits.")}</p>
      {catalogue === null && <p className="skills-page-note">{t("Can't load your skills right now. Try again when you're online.")}</p>}
      <h5 className="skills-page-heading">{t("Your skills · {n}", { n: mine.length })}</h5>
      {mine.length === 0 && catalogue !== null && <p className="skills-page-note">{t("You have no skills yet. Make one, or choose “Use as a skill” in a note's menu.")}</p>}
      {mine.length > 0 && <ul className="skills-list">{mine.map(row)}</ul>}
      <div className="skills-page-actions">
        <Button variant="secondary" size="sm" disabled={!online}
          onClick={() => openModuleDialog((close) => <NewSkillDialog onClose={() => { close(); invalidateQueries("/api/skills"); void refresh(); }} onOpenNode={(id) => open?.(id)} />)}>
          <Plus size={14} aria-hidden="true" /> {t("New skill")}
        </Button>
        <Button variant="secondary" size="sm" disabled={!online}
          onClick={() => openModuleDialog((close) => <ImportSkillDialog onClose={() => { close(); invalidateQueries("/api/skills"); void refresh(); }} onOpenNode={(id) => open?.(id)} />)}>
          <FileUp size={14} aria-hidden="true" /> {t("Import SKILL.md")}
        </Button>
      </div>
      {builtin.length > 0 && (
        <>
          <h5 className="skills-page-heading"><Sparkles size={14} aria-hidden="true" /> {t("Built in")}</h5>
          <ul className="skills-list">{builtin.map(row)}</ul>
        </>
      )}
    </div>
  );
}
