// Create a trusted offline Node test package for future Windows Sandbox runs.
// PREPARATION ONLY. This script never starts Windows Sandbox or executes test code.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageOfflineRunnerJob } from "../src/sandbox/offline-runner.mjs";
import { diagnoseSandbox } from "../src/sandbox/windows.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stagingRoot = path.join(root, ".pilot-workspace", "offline-runner-packages");
await fs.mkdir(stagingRoot, { recursive: true });
const sources = {
  "src/calc.mjs": "export function add(a,b) { return a+b; }\n",
  "test/calc.test.mjs": [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/calc.mjs';",
    "test('addition', () => assert.equal(add(2,3),5));",
    ""
  ].join("\n")
};
const job = await stageOfflineRunnerJob({
  stagingRoot, sources, tests: ["test/calc.test.mjs"],
  nodeExecutable: process.execPath, timeoutSeconds: 60, memoryMB: 6144
});
const availability = await diagnoseSandbox();
console.log(JSON.stringify({
  jobId: job.id, status: job.status,
  network: "disabled", executionEnabled: false,
  sandboxFeature: availability.featureState,
  manifestHash: job.manifestHash,
  configPath: job.configPath,
  note: "PREPARED ONLY. Do not launch until virtualization, isolation and end-to-end safety are verified."
}, null, 2));
