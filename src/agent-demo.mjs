import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPilotAgent } from "./agent/local-agent.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = path.join(projectRoot, ".pilot-workspace", "cli-" + Date.now());
console.log("Agent pilot workspace:", sandbox);
console.log("Ollama: loopback only. Tools: read_file, write_file, run_checks, finish.");
const result = await runPilotAgent({
  workspace: sandbox,
  onEvent: event => console.log(JSON.stringify(event))
});
await fs.writeFile(path.join(sandbox, "index.before.html"), result.before, "utf8");
await fs.writeFile(path.join(sandbox, "pilot-report.json"), JSON.stringify({
  ok: result.ok, summary: result.summary, check: result.check, events: result.events
}, null, 2), "utf8");
console.log(JSON.stringify({ ok: result.ok, summary: result.summary, checks: result.check, toolCount: result.toolCount }, null, 2));
if (!result.ok) process.exitCode = 2;
