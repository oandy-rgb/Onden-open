// A modal or sheet opens with the cursor in its main text field (components/ui/initialFocus.ts), whatever
// the content is: one rule in ui/Modal, not a per-dialog `autoFocus` (which does nothing while the <dialog> is
// still closed, so focus fell on the ✕ and typing went nowhere — owner, Galaxy Tab S9, 2026-11-17).
// A failure says what to do: open a dialog through ui/Modal or ui/Sheet; do not call showModal() yourself.
// The behaviour itself is tested in test/dialogInitialFocus.test.tsx; this keeps its three supports in place.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "test" && name !== "node_modules") walk(path, out); }
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

describe("where focus starts in a dialog", () => {
  it("only ui/Modal calls showModal(), so every dialog gets the one initial-focus rule", () => {
    const callers = walk(SRC).map((p) => relative(SRC, p).split(sep).join("/")).filter((p) => /\.showModal\(/.test(read(p)));
    expect(callers).toEqual(["components/ui/Modal.tsx"]);
  });

  it("ui/Modal applies the rule after it opens, and the ✕ is marked so it is never the start", () => {
    expect(read("components/ui/Modal.tsx")).toMatch(/dialog\.showModal\(\);[\s\S]*focusInitial\(dialog\)/);
    expect(read("components/ui/CloseButton.tsx")).toContain("DISMISS_PROPS");
  });

  it("the test setup behaves like a browser here (closed dialog takes no focus; showModal focuses the first control)", () => {
    // Without it a test passes on a dialog whose field has no focus on a device.
    const setup = read("test/setup.ts");
    expect(setup).toContain("dialog focusing steps");
    expect(setup).toMatch(/!dialog\.open\) return/);
  });

  // A ✕ drawn by hand in a dialog is not CloseButton, so it would not be skipped as the starting point.
  // The list only shrinks; a listed file says why its ✕ is not the dialog's own.
  // ratchet:list HAND_DRAWN_CLOSE
  const HAND_DRAWN_CLOSE: Record<string, string> = {
    "components/history/NoteHistory.tsx": "closes the versions side panel and a notice inside the dialog, not the dialog",
  };
  const usesDialog = /<(Modal|Sheet|ShellDialog)\b/;
  const dialogFiles = () => walk(SRC).map((p) => relative(SRC, p).split(sep).join("/"))
    .filter((p) => !p.startsWith("components/ui/") && usesDialog.test(read(p)));

  it("a hand-drawn Close button in a dialog file carries DISMISS_PROPS, or is listed with its reason", () => {
    const bad = dialogFiles().filter((p) => {
      const src = read(p);
      if (!/aria-label=\{t\("Close"\)\}/.test(src) || p in HAND_DRAWN_CLOSE) return false;
      return [...src.matchAll(/<(?:Pressable|Button)\b[^>]*aria-label=\{t\("Close"\)\}[^>]*>/g)].some((m) => !m[0].includes("DISMISS_PROPS"));
    });
    expect(bad, "use <SheetHeader> (CloseButton), or spread {...DISMISS_PROPS} on a header ✕ drawn by hand").toEqual([]);
    expect(Object.keys(HAND_DRAWN_CLOSE).filter((p) => !dialogFiles().includes(p)), "no longer a dialog file — drop it").toEqual([]);
  });

  // autoFocus on a field that mounts together with its <dialog> does nothing (the dialog is still closed):
  // ui/initialFocus decides. autoFocus stays right where the field mounts into something already shown.
  // ratchet:list AUTOFOCUS_IN_DIALOG_FILE
  const AUTOFOCUS_IN_DIALOG_FILE: Record<string, string> = {
    "components/CreateSheet.tsx": "the same body is drawn in a Popover on desktop, which is displayed when it mounts",
    "components/SidebarTagTree.tsx": "the field is in the sidebar, not in its two ShellDialogs",
  };
  it("a file that opens a Modal or Sheet writes no autoFocus, except the listed ones", () => {
    const bad = dialogFiles().filter((p) => /\bautoFocus\b/.test(read(p)) && !(p in AUTOFOCUS_IN_DIALOG_FILE));
    expect(bad, "delete autoFocus: the dialog puts focus in its main field itself (components/ui/initialFocus.ts)").toEqual([]);
    expect(Object.keys(AUTOFOCUS_IN_DIALOG_FILE).filter((p) => !dialogFiles().includes(p) || !/\bautoFocus\b/.test(read(p))), "no longer needed — drop it").toEqual([]);
  });
});
