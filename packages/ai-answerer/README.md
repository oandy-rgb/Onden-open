# @onden/ai-answerer

Lets an AI command-line tool, already logged in on a computer, pull questions from Onden and answer them.
Usage and the safety model: [docs/self-host/ai-client-on-a-machine.md](../../docs/self-host/ai-client-on-a-machine.md).

Supported AI tools today (auto-detected in this order unless `--tool` / `ONDEN_AI_TOOL` is specified):

| `--tool` id | Tool | Executable | Transport / Isolation |
| --- | --- | --- | --- |
| `claude-code` | Claude Code | `claude` | Headless JSON (`-p --output-format json`), `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--no-session-persistence` |
| `codex` | OpenAI Codex CLI | `codex` | Headless JSONL (`codex exec --json --ephemeral --sandbox read-only`), isolated `CODEX_HOME` (only `auth.json` + 0600 `config.toml`), `shell_tool = false`, `web_search = "disabled"` |
| `gemini` | Google Gemini CLI | `gemini` | Headless JSON (`-p "" --output-format json`), 0600 `GEMINI_CLI_SYSTEM_SETTINGS_PATH` (`coreTools: []`, built-in tools excluded, `mcp.allowed: ["onden"]`), `--allowed-mcp-server-names onden`, `--extensions none` |
| `antigravity` | Google Antigravity | `agy` / `agy_acp_server` | ACP JSON-RPC 2.0 over stdio (`agy acp` or standalone `agy_acp_server`), zero client capabilities, fail-closed permission handler allowing only Onden MCP |
| `copilot` | GitHub Copilot CLI | `copilot` | ACP JSON-RPC 2.0 over stdio (`copilot --acp`), all built-in tools denied (`--deny-tool=…`), `--disable-builtin-mcps`, `--no-custom-instructions`, `--no-auto-update`, fail-closed permission handler |

Plain Node ES modules (JSDoc types, `tsc` checks them), no build step, no dependencies, so it runs straight from a checkout
and the desktop app can import it.

| File | Responsibility |
| --- | --- |
| `src/protocol.mjs` | The HTTP protocol (pending, claim, events, status, finish with retry). Pure: takes `fetch`. |
| `src/prompt.mjs` | Prompt assembly from `claim`'s `rendered`, and reading the tool's JSON output. |
| `src/adapters/` | One adapter per AI tool (`claudeCode.mjs`, `codex.mjs`, `gemini.mjs`, `antigravity.mjs`, `copilot.mjs`) plus shared `runtime.mjs` & `acp.mjs`. A plain list, not a plugin system; `safety.guard.test.ts` locks every adapter's safety flags. |
| `src/loop.mjs` | One question at a time, cancel and deadline, never a tight retry loop. |
| `src/address.mjs`, `src/keyFile.mjs` | Which server addresses are allowed; reading the connection code from a 0600 file. |
| `src/service.mjs`, `src/cli.mjs` | systemd user service (Linux) and the command line (`--tool`, `--tool-command`). |
| `src/testing/fakeTool.mjs` | A stand-in executable that records how it was started (tests only). |

The loop is also tested against the real backend routes: `packages/backend/src/test/aiAnswerer.integration.test.ts`.
