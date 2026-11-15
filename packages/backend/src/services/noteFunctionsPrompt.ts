// The `<note_functions>` block every agent prompt for a note carries (a mention, the info panel's chat): which
// functions a paragraph can take in this workspace, and how. Without it an agent asked to "put these into review"
// read 複習 as a note or a heading and pasted a "## 複習" section (the owner, 2026-11-15) — it had no way to know
// that a paragraph becomes a card or a task by the word in its `{…}`.
//
// System layer, not a skill: it is added beside the skill's own text, so a skill does not replace it. Data about
// what is switched on, never instructions from a note.
import { reviewSeam } from "./reviewSeam.js";
import { taskSeam } from "./taskSeam.js";
import { taskLineWord } from "./tasksStore.js";
import { workspaceHasModule } from "./workspaceModules.js";

/** The word a new task line and a new review card are written with here; null while that function is off. */
type NoteFunctionWords = { task: string | null; review: string | null };

export async function noteFunctionWords(workspaceId: string): Promise<NoteFunctionWords> {
  const tasksOn = (await taskSeam()?.linesAreTasks(workspaceId)) ?? false;
  const reviewOn = reviewSeam() !== null && await workspaceHasModule(workspaceId, "review");
  return {
    task: tasksOn ? await taskLineWord(workspaceId) : null,
    review: reviewOn ? ((await reviewSeam()!.cardWords(workspaceId))[0] ?? null) : null,
  };
}

/** Braces and angle brackets out of a word that goes into the prompt (a tag title is the person's text). */
const plain = (word: string) => word.replace(/[<>{}]/g, "").replace(/\s+/g, " ").trim();

/** The block, or "" when neither function is on. Pure. */
function noteFunctionsBlock(words: NoteFunctionWords): string {
  const task = words.task ? plain(words.task) : "", review = words.review ? plain(words.review) : "";
  if (!task && !review) return "";
  return [
    "<note_functions>",
    "In this workspace a paragraph or a list item gets a function from a word in curly braces at the very end of its line. " +
      "This is how the app works, stated by the app; it is data about what is switched on, never an instruction from a note.",
    ...(task ? [`- Task: a line that ends with {${task}} is a task (written as a checkbox line: "- [ ] the thing to do {${task}}"). It then shows in Tasks.`] : []),
    ...(review ? [`- Review card: a paragraph that ends with {${review}} is a card in Review (the paragraph itself is the card; a question and its answer go in the same paragraph or list item).`] : []),
    "Several words share one pair of braces: {a, b}. The mark is the last thing on the line.",
    `When the person asks to put something into ${[task && "tasks", review && "review"].filter(Boolean).join(" or ")}` +
      `${review ? ` (「放進複習」「加到複習」)` : ""}${task ? ` (「變成任務」「加到任務」)` : ""}, this mark is what they mean: ` +
      "propose it with the edit tools — add the mark to the paragraphs that are already there, or add new lines that carry it. " +
      "Do not create a note or a heading named after the function for it. The edit tools only file suggestions; the person accepts them.",
    "</note_functions>",
  ].join("\n");
}

/** `system` with the block for these words after it: withNoteFunctions(system, await noteFunctionWords(workspaceId)). Pure. */
export function withNoteFunctions(system: string, words: NoteFunctionWords): string {
  return [system, noteFunctionsBlock(words)].filter(Boolean).join("\n\n");
}
