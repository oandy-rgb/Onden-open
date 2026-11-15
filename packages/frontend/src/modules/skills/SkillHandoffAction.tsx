import { Sparkles } from "lucide-react";
import { Pressable } from "../../components/ui";
import { useMemo } from "react";
import { addToast, useOnline, useTagRows } from "../../lib/appStore";
import { useT } from "../../lib/i18n";
import { skillsFor } from "../../lib/agentMentions";
import { requestHandOff } from "../../lib/mentionHandOff";
import { spaceLabel, useSpaces, type Space } from "../../lib/spaces";
import { nodeHasTagModule } from "../../lib/tagModules";
import { useNoteSkills } from "../../hooks/useNoteSkills";
import type { NoteHeaderActionProps } from "../types";
import type { NoteSkill } from "../../lib/agentMentions";
import { nodeTagIds } from "../../lib/nodeTags";

/** The skills that are for this note's tags, each a button 「交給 AI：技能名」,
 *  and — on a skill note — a line when the note's space keeps it from the AI (so
 *  the skill never reaches the catalogue). The button writes `@ai /[[skill]]`
 *  into the note and sends it, the same request as typing it (lib/mentionHandOff). */
export default function SkillHandoffAction({ node, readOnly }: NoteHeaderActionProps) {
  const t = useT();
  const online = useOnline();
  const tags = useTagRows();
  const { skills } = useNoteSkills({ autoload: !readOnly || nodeHasTagModule(node, tags ?? [], "skills"), online });
  const spaces = useSpaces(online).spaces;
  const offered = useMemo(
    () => skillsFor(skills ?? [], nodeTagIds(node)),
    [skills, node]);
  const space = node.space_id ? spaces.find((candidate) => candidate.id === node.space_id) ?? null : null;
  const keptAwayIn = nodeHasTagModule(node, tags ?? [], "skills") && space && space.capabilities.external_ai !== true ? space : null;
  return <SkillHandoffView offered={readOnly ? [] : offered} offline={!online} keptAwayIn={keptAwayIn}
    onHandOff={(skill) => { if (!requestHandOff(node.id, skill.name)) addToast(t("Open the note to hand it to the AI."), "error"); }} />;
}

export function SkillHandoffView({ offered, offline, onHandOff, keptAwayIn }: {
  offered: readonly NoteSkill[];
  offline: boolean;
  onHandOff: (skill: NoteSkill) => void;
  /** This is a skill note and its space does not let AI read notes. */
  keptAwayIn: Pick<Space, "kind" | "is_default" | "name"> | null;
}) {
  const t = useT();
  if (offered.length === 0 && !keptAwayIn) return null;
  return (
    <>
      {offered.map((skill) => (
        <Pressable key={skill.id} type="button" className="skill-handoff-btn tap-target" disabled={offline}
          title={offline ? t("Sending needs a connection.") : skill.description || undefined}
          onClick={() => onHandOff(skill)}>
          <Sparkles size={14} aria-hidden="true" />
          <span>{t("Hand to AI: {name}", { name: skill.name })}</span>
        </Pressable>
      ))}
      {keptAwayIn && (
        <details className="skill-handoff-away">
          <summary className="tap-target">{t("The AI can't see this skill")}</summary>
          <p role="note">
            {t("This skill is in “{space}”, which keeps notes away from AI, so the AI can't see it. Move it to a space that lets AI read notes (such as Everyone) to use it.", { space: spaceLabel(keptAwayIn) })}
          </p>
        </details>
      )}
    </>
  );
}
