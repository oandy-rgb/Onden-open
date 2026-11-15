// Skills module (frontend) — notes as skills for your own AI
// (docs/architecture/harness.md):
//   • noteSwitch — 「當成技能」: on, a row of the note's info panel; off, in its ⋯
//     menu and ⌘K. A skill is a feature, not
//     a tag: the switch adds and removes the module's inside tag (moduleTag
//     "skill"), which no list shows (lib/nodeTags isNoteSwitchTag);
//   • settings — Settings › Features › Skills: the skill list with each one's
//     「給 AI 用」 switch, new skill and SKILL.md import;
//   • the catalogue (GET /api/skills) and SKILL.md import.
// Onden runs no model: a skill is used by an AI through MCP prompts, by an
// @ai mention in a note (`@ai /[[skill]]`), or — when 「給 AI 用」 is on — picked
// by the AI itself from the list its prompt carries (loadSkill). The backend
// module of the same id owns the tag. The applies_to header buttons are
// 「交給 AI：技能」 (modules/skills/SkillHandoffAction.tsx): a button writes
// that mention and sends it.
import { Suspense } from "react";
import { Sparkles } from "lucide-react";
import type { FrontendModule, NoteHeaderActionProps } from "../types";
import type { SettingContext } from "../../lib/settingsTypes";
import { openModuleDialog } from "../../lib/moduleDialog";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { skillsTagFunction } from "./tagFunction";
import { isNote } from "@onden/markdown/contract";

// Dialogs, fields and the page load when shown (lib/moduleDialog shows dialogs inside a Suspense).
const SkillHandoffAction = lazyWithReload(() => import("./SkillHandoffAction"));
const ImportSkillDialog = lazyWithReload(() => import("./ImportSkillDialog"));
const NewSkillDialog = lazyWithReload(() => import("./NewSkillDialog"));
const SkillNoteFields = lazyWithReload(() => import("./SkillNoteFields"));
const SkillsSettings = lazyWithReload(() => import("./SkillsSettings"));

const SkillHandoffHeaderAction = (props: NoteHeaderActionProps) => <Suspense fallback={null}><SkillHandoffAction {...props} /></Suspense>;
const SkillsSettingsWidget = ({ ctx }: { ctx: SettingContext }) => <Suspense fallback={null}><SkillsSettings ctx={ctx} /></Suspense>;

export const skillsModule: FrontendModule = {
  id: "skills",
  library: {
    title: "Skills",
    description: "Turn a note into a skill: choose “Use as a skill” in the note menu, and your AI can use it through MCP.",
    Icon: Sparkles,
    requires: ["ai"],
    group: { id: "ai", order: 2 },
    blurb: "Hand a note to AI as a way to do things",
    moduleTag: { name: "skill" },
    manifest: {
      adds: [
        { kind: "command", text: "Import a SKILL.md as a skill note." },
      ],
      notes: "Notes with “Use as a skill” on become skills that your AI can use through MCP.",
      network: null,
    },
  },
  tagFunction: skillsTagFunction,
  noteSwitch: {
    label: "Use as a skill",
    Fields: SkillNoteFields,
  },
  settings: [{
    id: "modules.skills_list",
    tab: "modules",
    // The widget titles its own blocks.
    label: "",
    keywords: ["skills", "ai", "skill.md", "技能", "給 AI 用", "匯入", "新增技能"],
    type: "custom",
    component: SkillsSettingsWidget,
  }],
  // A SKILL.md written elsewhere is imported from the skills page or the palette.
  dialogEntry: {
    label: "Import SKILL.md…",
    Icon: Sparkles,
    keywords: ["skill", "import", "skill.md", "技能", "匯入"],
    open: ({ onOpenNode }) => openModuleDialog((close) => <ImportSkillDialog onClose={close} onOpenNode={onOpenNode} />),
  },
  noteHeaderAction: SkillHandoffHeaderAction,
  noteCommands: [
    {
      id: "b-new-skill",
      label: "New skill",
      keywords: ["skill", "create", "add", "new", "技能", "新增"],
      // Writing a note works offline (queued).
      available: (node) => isNote(node),
      run: ({ openNode }) => openModuleDialog((close) => <NewSkillDialog onClose={close} onOpenNode={openNode} />),
    },
  ],
};
