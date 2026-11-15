// The reads-through-data lint rule: importing the api()/apiFetch()/postRead*
// transport from lib/api is an error; types and other helpers are fine.
import { describe, it } from "vitest";
import { RuleTester, type Rule } from "eslint";
import typescriptParser from "@typescript-eslint/parser";
import readsThroughData from "../../eslint-rules/reads-through-data.js";

const rule = readsThroughData as unknown as Rule.RuleModule;

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parser: typescriptParser, ecmaVersion: 2022, sourceType: "module" } });

tester.run("reads-through-data", rule, {
  valid: [
    "import { reads } from '../lib/data';",
    "import type { ContentNode } from '../lib/api';",
    "import { type ContentNode, nodeNeedsBody, ApiError } from '../lib/api';",
    "import { readWithDeadline } from './api';",
    "import { api } from './apiHelpers';",
  ],
  invalid: [
    { code: "import { api } from '../lib/api';", errors: [{ messageId: "raw" }] },
    { code: "import { apiFetch, type Tag } from '../../lib/api';", errors: [{ messageId: "raw" }] },
    { code: "import { postRead, postReadResponse } from './api';", errors: [{ messageId: "raw" }, { messageId: "raw" }] },
    { code: "import { api as get } from '../api';", errors: [{ messageId: "raw" }] },
  ],
});
