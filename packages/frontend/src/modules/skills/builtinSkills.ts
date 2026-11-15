// The server's built-in skills (backend services/harness/builtinSkills.ts) are
// named in English on the wire; their display text lives here as literals so
// i18n sees them (t(s.name) on a dynamic value would hide them from the key
// check). builtinSkills.test pins this list to the backend's ids.
import { t } from "../../lib/i18n";

// Getters, so the text follows the current language.
export const BUILTIN_SKILL_TEXT: Record<string, { name: () => string; description: () => string }> = {
  ask: { name: () => t("Ask"), description: () => t("Answer a question from your notes, citing each claim [n].") },
  outline: { name: () => t("Slide outline"), description: () => t("Turn a board, a tag's notes or chosen notes into a slide outline.") },
  expand: { name: () => t("Expand"), description: () => t("Add detail and examples to the selected text.") },
  summarize: { name: () => t("Summarize"), description: () => t("Summarize the selected text in one or two sentences.") },
  rewrite: { name: () => t("Rewrite"), description: () => t("Rewrite the selected text so it reads better, keeping the meaning.") },
  shorten: { name: () => t("Shorten"), description: () => t("Make the selected text shorter without losing the point.") },
  translate: { name: () => t("Translate"), description: () => t("Translate the selected text (to English, or to Traditional Chinese if it is already English).") },
  explain: { name: () => t("Explain"), description: () => t("Keep the selected text and add a short plain explanation after it.") },
  fix: { name: () => t("Fix"), description: () => t("Fix grammar and spelling and improve clarity.") },
  mention: { name: () => t("Mention"), description: () => t("Answer an @mention in a note.") },
};
