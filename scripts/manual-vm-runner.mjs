/**
 * Manual VM runner entry point. NEVER invoked by the web server.
 * Default mode is read-only. Real execution requires four independent gates:
 * enabled Sandbox, interactive Windows account, opt-in env var, typed job
 * approval phrase. No arbitrary project source selection is exposed yet.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { probeWindowsVm, expectedVmApproval, runWindowsVmJob, manualVmExitStatus } from "../src/sandbox/vm-controller.mjs";
import { stageOfflineRunnerJob } from "../src/sandbox/offline-runner.mjs";
import { diagnoseSandbox } from "../src/sandbox/windows.mjs";
import { VmOwnershipJournal } from "../src/sandbox/vm-journal.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !["--status", "--run-demo"].includes(args[0]))) {
  console.error("Usage: node scripts/manual-vm-runner.mjs [--status|--run-demo]");
  process.exit(2);
}
const mode = args[0] ?? "--status";
const root = path.resolve(process.env.STUDIO_RUNNER_JOBS_ROOT ??
  (process.env.LOCALAPPDATA ?
    path.join(process.env.LOCALAPPDATA, "AIStudio", "SandboxJobs") :
    path.join(process.cwd(), ".pilot-workspace", "offline-runner-packages")));
const journal = new VmOwnershipJournal(root);
const [host, feature, priorOwnership] = await Promise.all([
  probeWindowsVm(), diagnoseSandbox(), journal.inspect()
]);
console.log(JSON.stringify({
  schema: host.schema,
  platform: host.platform,
  featureState: feature.featureState,
  hostSession: host.session,
  cliPresent: host.cliPresent,
  featureReady: host.featureReady,
  executionEnabled: false,
  reason: host.reason,
  vmOwnership: priorOwnership,
  note: "Read-only diagnostic. No VM has been launched."
}, null, 2));
if (mode === "--status") process.exit(0);

if (priorOwnership.active) {
  console.error("A previous VM ownership record requires manual review before any new run.");
  process.exit(2);
}
if (!host.featureReady) {
  console.error("Sandbox unavailable; no staging or execution attempted.");
  process.exit(2);
}
if (process.env.STUDIO_ALLOW_VM_EXECUTION !== "1") {
  console.error("Manual opt-in required: STUDIO_ALLOW_VM_EXECUTION=1.");
  process.exit(2);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Refusing VM execution from a service, pipe, automation or non-interactive terminal.");
  process.exit(2);
}
const rootUpper = path.parse(root).root;
if (root.toLowerCase() === rootUpper.toLowerCase() || root.length > 200) {
  throw Error("unsafe-runner-root");
}
await fs.mkdir(root, { recursive: true });
const sources = {
  "src/add.mjs": "export const add=(a,b)=>a+b;\n",
  "test/add.test.mjs": [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/add.mjs';",
    "test('adds two values',()=>assert.equal(add(2,3),5));",
    ""
  ].join("\n")
};
const staged = await stageOfflineRunnerJob({
  stagingRoot: root, sources, tests: ["test/add.test.mjs"],
  nodeExecutable: process.execPath, timeoutSeconds: 30, memoryMB: 6144
});
console.log(JSON.stringify({
  status: staged.status, jobId: staged.id, manifestHash: staged.manifestHash,
  guestNetwork: "disabled", vmMemoryMB: staged.manifest.memoryMB,
  note: "Sample Node test only. The VM result is untrusted and never auto-approves any project change."
}, null, 2));
const phrase = expectedVmApproval(staged);
const reader = createInterface({ input: process.stdin, output: process.stdout });
let entered = "";
try {
  entered = await reader.question("To run ONLY this isolated sample, type:\n" + phrase + "\n> ");
} finally {
  reader.close();
}
if (entered !== phrase) {
  console.error("No approval matched. Package retained but never executed.");
  process.exit(2);
}
const controller = new AbortController();
function cancel() {
  controller.abort(new DOMException("operator-requested-cancel", "AbortError"));
}
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
try {
  const outcome = await runWindowsVmJob({
    staged, approval: entered,
    executionOptIn: process.env.STUDIO_ALLOW_VM_EXECUTION === "1",
    interactiveConfirmation: true, signal: controller.signal,
    journal, onEvent: event => console.log("VM EVENT " + JSON.stringify(event))
  });
  console.log(JSON.stringify({
    jobId: staged.id, vmId: outcome.vmId, guestStatus: outcome.status,
    sandboxStopped: outcome.sandboxStopped,
    trusted: false, requiresHumanReview: true,
    stdout: outcome.stdout, stderr: outcome.stderr,
    operatorExitCode: manualVmExitStatus(outcome)
  }, null, 2));
  process.exitCode = manualVmExitStatus(outcome);
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
