// The modals-through-ui-modal lint rule (D99): a hand-made modal — aria-modal,
// a raw <dialog>/showModal(), or role="dialog" on an HTML element — is an
// error outside components/ui; asking ui/Modal for a role is fine.
import { describe, it } from "vitest";
import { RuleTester, type Rule } from "eslint";
import typescriptParser from "@typescript-eslint/parser";
import modalsThroughUiModal from "../../eslint-rules/modals-through-ui-modal.js";

const rule = modalsThroughUiModal as unknown as Rule.RuleModule;

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({
  languageOptions: { parser: typescriptParser, ecmaVersion: 2022, sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
});

tester.run("modals-through-ui-modal", rule, {
  valid: [
    "const a = <Modal label='Ask' role='alertdialog' onClose={close}><div className='card' /></Modal>;",
    "const a = <Modal label='History' className='hv-backdrop' onClose={close}><div /></Modal>;",
    "const a = <div role='group' aria-label='Choose' />;",
    "const a = <div role={role} />;",
    "menu.show();",
  ],
  invalid: [
    { code: "const a = <div className='x-modal' role='dialog' aria-modal='true' />;", errors: [{ messageId: "handMade" }, { messageId: "handMade" }] },
    { code: "const a = <div className='x-overlay'><div role=\"alertdialog\" /></div>;", errors: [{ messageId: "handMade" }] },
    { code: "const a = <section aria-modal />;", errors: [{ messageId: "handMade" }] },
    { code: "const a = <dialog open />;", errors: [{ messageId: "handMade" }] },
    { code: "ref.current.showModal();", errors: [{ messageId: "handMade" }] },
  ],
});
