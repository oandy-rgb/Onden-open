// A stand-in for the AI command-line tool, for tests: an executable that records how it was started
// (arguments, environment, working directory and what was in it, the MCP config file and its mode, stdin)
// into $FAKE_TOOL_RECORD and then behaves as $FAKE_TOOL_MODE says. Not used by the program itself.
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("0.0.0-fake"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: process.env.FAKE_TOOL_LOGGED_IN !== "no" })); process.exit(0); }
let stdin = "";
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  const i = args.indexOf("--mcp-config");
  const configFile = i >= 0 ? args[i + 1] : null;
  let configText = null, configMode = null;
  try { configText = fs.readFileSync(configFile, "utf8"); configMode = fs.statSync(configFile).mode & 0o777; } catch {}
  fs.writeFileSync(process.env.FAKE_TOOL_RECORD, JSON.stringify({
    args, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), env: process.env, configFile, configText, configMode, stdin,
  }));
  const mode = process.env.FAKE_TOOL_MODE || "answer";
  if (mode === "hang") { setInterval(() => {}, 1000); return; }
  if (mode === "error") { console.log(JSON.stringify({ is_error: true, result: "Not logged in" })); return; }
  if (mode === "garbage") { console.log("not json"); return; }
  console.log(JSON.stringify({ type: "result", is_error: false, result: process.env.FAKE_TOOL_ANSWER || ("answer: " + stdin.split("\\n").pop()) }));
});
`;

/** Writes the executable into `dir` and returns its path. @param {string} dir */
export async function writeFakeTool(dir) {
  const file = join(dir, "fake-ai-tool");
  await writeFile(file, SCRIPT);
  await chmod(file, 0o755);
  return file;
}
