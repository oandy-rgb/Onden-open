// D85: a key hint written out by hand ("Search notes (⌘F)", <kbd>⌘K</kbd>)
// ignores the person's rebinding and shows mac glyphs on Windows. Hints go
// through lib/shortcuts (kbdHint / useKbdHint / formatChord); this guard keeps
// new hand-written ones out of app UI code.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// lib/shortcuts owns the glyphs. The example notes are content, not the app's
// shortcut UI.
const SKIP = [/^lib\/shortcuts\.ts$/, /^test\//, /^data\//, /^lib\/i18n\.zh-TW(\.boot|\.late)?\.ts$/];
// Settings › Keyboard shortcuts names the modifiers in general, not a chord.
const ALLOWED = [
  "Shortcuts without ⌘/Ctrl work only when you are not typing in a text field.",
  "{keys} can't be a shortcut. Use a key with ⌘/Ctrl, Shift or Alt.",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

// String literals and JSX text, with comments removed.
function codeWithoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

describe("key hints", () => {
  it("no app UI code writes a chord out by hand", () => {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (SKIP.some((re) => re.test(rel))) continue;
      let code = codeWithoutComments(readFileSync(file, "utf8"));
      for (const allowed of ALLOWED) code = code.split(allowed).join("");
      for (const line of code.split("\n")) {
        if (/[⌘⇧⌥]|\bCtrl\+[A-Za-z]/.test(line)) found.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(found).toEqual([]);
  });
});
