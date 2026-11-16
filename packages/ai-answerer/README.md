# @onden/ai-answerer

Lets an AI command-line tool, already logged in on a computer, pull questions from Onden and answer them.
Usage and the safety model: [docs/self-host/ai-client-on-a-machine.md](../../docs/self-host/ai-client-on-a-machine.md).

Supported AI tools today: the Claude Code command-line tool (`src/adapters/claudeCode.mjs`), logged in on the computer.

Plain Node ES modules (JSDoc types, `tsc` checks them), no build step, no dependencies, so it runs straight from a checkout
and the desktop app can import it.

| File | Responsibility |
| --- | --- |
| `src/protocol.mjs` | The HTTP protocol (pending, claim, events, status, finish with retry). Pure: takes `fetch`. |
| `src/prompt.mjs` | Prompt assembly from `claim`'s `rendered`, and reading the tool's JSON output. |
| `src/adapters/` | One adapter per AI tool: `{ id, label, detect(), run() }`. A plain list, not a plugin system. |
| `src/adapters/claudeCode.mjs` | The shipped adapter. Owns the safety flags; `safety.guard.test.ts` locks them. |
| `src/loop.mjs` | One question at a time, cancel and deadline, never a tight retry loop. |
| `src/address.mjs`, `src/keyFile.mjs` | Which server addresses are allowed; reading the connection code from a 0600 file. |
| `src/service.mjs`, `src/cli.mjs` | systemd user service (Linux) and the command line. |
| `src/testing/fakeTool.mjs` | A stand-in executable that records how it was started (tests only). |

The loop is also tested against the real backend routes: `packages/backend/src/test/aiAnswerer.integration.test.ts`.
