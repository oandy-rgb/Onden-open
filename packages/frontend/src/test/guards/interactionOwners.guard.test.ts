// @vitest-environment node
// Guard: browser-interaction jobs belong to ONE owner each (allowlist, default deny).
// A file not named in an owner list may not do the job; the list says why each is there.
// Temporary exceptions are files other in-flight branches are editing; they only shrink.
import { describe, expect, it } from "vitest";
import { entryHint } from "../../../../../scripts/entrypointsCatalog.mjs";
import { findUses, sourceFiles } from "./sources";

const files = sourceFiles(".");

type Rule = { name: string; entry: string; pattern: RegExp; owners: string[]; temporary?: string[]; violating: string; fine: string };

const RULES: Rule[] = [
  {
    entry: "page-hide",
    name: "leaving the page (pagehide/beforeunload) is lib/pageHide's onPageHide",
    pattern: /["'](pagehide|beforeunload)["']/,
    owners: ["lib/pageHide.ts"],
    violating: `window.addEventListener("pagehide", flush);`,
    fine: `onPageHide(flush);`,
  },
  {
    entry: "app-resume",
    name: "visibilitychange is lib/pageHide's (saving) or lib/appResume's (re-checking on return)",
    pattern: /["']visibilitychange["']/,
    owners: ["lib/pageHide.ts", "lib/appResume.ts"],
    violating: `document.addEventListener("visibilitychange", read);`,
    fine: `onPageHide(flush);`,
  },
  {
    entry: "transient-flag",
    name: "a flag that resets itself after a delay is hooks/useTransientFlag",
    pattern: /setTimeout\(\s*\(\)\s*=>\s*set\w+\((false|null)\)/,
    owners: ["hooks/useTransientFlag.ts"],
    // OverviewEditor is being changed by refactor/one-bottom-sheet; its five upload-error timers move to useAutoReset after it lands.
    // ratchet:list transient-flag-temporary
    temporary: ["components/OverviewEditor.tsx"],
    violating: `setTimeout(() => setCopied(false), 1500);`,
    fine: `const [copied, flashCopied] = useTransientFlag();`,
  },
  {
    entry: "clipboard",
    name: "navigator.clipboard is lib/clipboard",
    pattern: /navigator\.clipboard|\bClipboardItem\b/,
    owners: ["lib/clipboard.ts"],
    violating: `await navigator.clipboard.writeText(text);`,
    fine: `await copyText(text);`,
  },
  {
    entry: "session-prefs",
    name: "sessionStorage is lib/sessionPrefs",
    pattern: /\bsessionStorage\b/,
    owners: ["lib/sessionPrefs.ts"],
    violating: `window.sessionStorage.getItem(key);`,
    fine: `readSession(key);`,
  },
  {
    entry: "ui-modal",
    name: "a hand-made alertdialog is components/ui (use Modal role=\"alertdialog\")",
    pattern: /<(?!Modal\b)\w+[^>]*role="alertdialog"/,
    owners: ["components/ui/Modal.tsx"],
    violating: `<div className="inline-confirm" role="alertdialog">`,
    fine: `<Modal label="x" role="alertdialog" onClose={close}>`,
  },
  {
    entry: "split-open",
    name: "what the right side shows is set by lib/splitViewStore and hooks/useSplitView (their rules: no view twice, ⇄, the address)",
    pattern: /\bsetRight\(/,
    owners: ["lib/splitViewStore.ts", "hooks/useSplitView.ts"],
    violating: `setRight({ kind: "note", id, tab: "content" });`,
    fine: `requestSplitOpen({ kind: "note", id, tab: "content" }, "right");`,
  },
];

describe.each(RULES)("$name", (rule) => {
  it("is done by its owner only", () => {
    expect(findUses(files, rule.pattern, [...rule.owners, ...(rule.temporary ?? [])]), entryHint(rule.entry)).toEqual([]);
  });
  it("catches a violation and passes the owner's call (self-check)", () => {
    expect(rule.pattern.test(rule.violating)).toBe(true);
    expect(rule.pattern.test(rule.fine)).toBe(false);
  });
  it("lists only exceptions that still need it", () => {
    const still = new Set(findUses(files, rule.pattern).map((use) => use.split(":")[0]));
    for (const file of rule.temporary ?? []) expect(still.has(file), `${file} no longer needs its exception`).toBe(true);
  });
});
