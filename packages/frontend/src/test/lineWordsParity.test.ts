// The server and the editor answer the same question about a line — "is `- [ ] … {word}` a task here?" — for the
// same workspace. The server's answer is the one its save uses (backend services/lineWordRules: the words from the
// tag world, lineIsTask); the editor's is what it draws (the task icon) from the words the server sends on
// `workspace.line_words` (lib/lineWords). Before there was one owner, the editor knew a single word (the module tag's
// current name) and the server also took the reserved `task`: a line `{task}` became a task the editor drew as text.
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { parseBlocks } from "@onden/markdown";
import { editorBlocks, blockTaskWords } from "../lib/editorBlocks";
import { activeWords } from "../lib/lineWords";
import { lineIsTask, taskLineWords } from "../../../backend/src/services/lineWordRules";

type World = { name: string; names: string[]; otherTagNamed: boolean; on: boolean };
// What functionTagNames finds for each workspace: the tasks module tag's current name(s), and whether an ordinary tag
// holds the name `task`.
const WORLDS: World[] = [
  { name: "usual: the module tag is called task", names: ["task"], otherTagNamed: false, on: true },
  { name: "the module tag was renamed", names: ["待辦"], otherTagNamed: false, on: true },
  { name: "the module tag has another name from the start", names: ["任務"], otherTagNamed: false, on: true },
  { name: "the user's own `task` tag, no module tag", names: [], otherTagNamed: true, on: true },
  { name: "the user's own `task` tag next to a renamed module tag", names: ["待辦"], otherTagNamed: true, on: true },
  { name: "no module tag and no `task` tag", names: [], otherTagNamed: false, on: true },
  { name: "the tasks module is off", names: ["task"], otherTagNamed: false, on: false },
  { name: "off, with a renamed module tag", names: ["待辦"], otherTagNamed: false, on: false },
];
const WORDS_TO_TRY = ["task", "Task", "待辦", "任務", "review", "其他"];

const views: EditorView[] = [];
afterEach(() => { views.splice(0).forEach((v) => { v.dom.parentElement?.remove(); v.destroy(); }); });

/** Whether the editor draws the task icon on the line, with the words a bootstrap of this workspace would carry. */
function editorDrawsTask(line: string, world: World): boolean {
  const wire = { line_words: { tasks: { words: taskLineWords(world, "task", "任務"), on: world.on } } };
  const words = activeWords(wire.line_words.tasks);
  const doc = `${line}\n\nplain`;
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [editorBlocks, blockTaskWords.of(words)] }) });
  views.push(view);
  return view.dom.querySelector(".cm-block-task-icon") !== null;
}

describe("a checkbox line carrying a word: server and editor agree", () => {
  for (const world of WORLDS) {
    it(world.name, () => {
      for (const word of WORDS_TO_TRY) {
        const line = `- [ ] 週五前讀完第 9 章 {${word}}`;
        const block = parseBlocks(line)[0]!;
        const server = lineIsTask({ checkbox: !!block.checkbox, tags: block.tags }, taskLineWords(world, "task", "任務"), world.on);
        expect(editorDrawsTask(line, world), `{${word}}`).toBe(server);
      }
    });
  }

  it("the cases are not all the same answer", () => {
    const answers = WORLDS.flatMap((world) => WORDS_TO_TRY.map((word) => {
      const block = parseBlocks(`- [ ] x {${word}}`)[0]!;
      return lineIsTask({ checkbox: !!block.checkbox, tags: block.tags }, taskLineWords(world, "task", "任務"), world.on);
    }));
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });

  it("a plain paragraph with the word is not a task line (no box), on both sides", () => {
    const world = WORLDS[0]!;
    const block = parseBlocks("週五前讀完 {task}")[0]!;
    expect(lineIsTask({ checkbox: !!block.checkbox, tags: block.tags }, taskLineWords(world, "task", "任務"), true)).toBe(false);
  });
});
