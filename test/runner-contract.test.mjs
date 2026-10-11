import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defineOfflineJob, safeRelativeFile, createOfflineRunnerProfile,
  stageOfflineRunnerJob, parseUntrustedRunnerResult, RUNNER_SCHEMA
} from "../src/sandbox/offline-runner.mjs";

const SAMPLES = {
  "src/sum.mjs": "export const sum=(a,b)=>a+b;\n",
  "test/sum.test.mjs": "import { test } from 'node:test';\nimport { sum } from '../src/sum.mjs';\ntest('works',()=>{if(sum(2,3)!==5)throw Error('wrong')});\n"
};
const TESTS = ["test/sum.test.mjs"];

test("defines reproducible offline test jobs without arbitrary shell commands", () => {
  const id = "f31f36a2-6f41-4e09-b93c-a1eb42de56c6";
  const a = defineOfflineJob({ id, sources: SAMPLES, tests: TESTS });
  const b = defineOfflineJob({ id, sources: { "test/sum.test.mjs": SAMPLES["test/sum.test.mjs"], "src/sum.mjs": SAMPLES["src/sum.mjs"] }, tests: TESTS });
  assert.equal(a.manifestHash, b.manifestHash);
  assert.equal(a.schema, RUNNER_SCHEMA);
  assert.equal(a.kind, "node-offline-tests");
  assert.equal(a.network, "disabled");
  assert.equal(a.executionPolicy, "vm-only");
});

test("rejects traversal, hidden paths, dependency trees, extensions and malformed jobs", () => {
  for (const name of ["../.env", "/tmp/secret", "node_modules/a.js", ".git/config", "a/../../b.mjs",
    "C:\\a\\b.mjs", "foo;whoami.mjs", "abc.exe", "some//path.js"]) {
    assert.throws(() => safeRelativeFile(name));
  }
  assert.throws(() => defineOfflineJob({ sources: SAMPLES, tests: ["../secrets.test.mjs"] }), /invalid-runner-test-files/);
  assert.throws(() => defineOfflineJob({ sources: SAMPLES, tests: ["foo.test.mjs"] }), /invalid-runner-test-files/);
  assert.throws(() => defineOfflineJob({ sources: SAMPLES, tests: TESTS, timeoutSeconds: 999 }), /invalid-runner-timeout/);
  assert.throws(() => defineOfflineJob({ sources: SAMPLES, tests: TESTS, memoryMB: 128 }), /invalid-sandbox-memory/);
});

test("Windows Sandbox configuration has read-only inputs, one writable result channel and no network", () => {
  const input = "D:\\StudioJobs\\f31f36a2-6f41-4e09-b93c-a1eb42de56c6\\bundle";
  const output = "D:\\StudioJobs\\f31f36a2-6f41-4e09-b93c-a1eb42de56c6\\output";
  const profile = createOfflineRunnerProfile({ inputHostFolder: input, outputHostFolder: output });
  assert.match(profile, /<Networking>Disable<\/Networking>/);
  assert.match(profile, /<vGPU>Disable<\/vGPU>/);
  assert.match(profile, /<ClipboardRedirection>Disable<\/ClipboardRedirection>/);
  assert.match(profile, /<ProtectedClient>Enable<\/ProtectedClient>/);
  assert.match(profile, /<ReadOnly>true<\/ReadOnly>/);
  assert.match(profile, /<ReadOnly>false<\/ReadOnly>/);
  assert.doesNotMatch(profile, /<LogonCommand>/);
  assert.throws(() => createOfflineRunnerProfile({ inputHostFolder: "C:\\Jobs\\folder", outputHostFolder: "C:\\Jobs\\folder\\output" }), /overlap/);
  assert.throws(() => createOfflineRunnerProfile({ inputHostFolder: "\\\\server\\share", outputHostFolder: output }), /unsafe/);
  assert.throws(() => createOfflineRunnerProfile({ inputHostFolder: "D:\\unsafe&whoami", outputHostFolder: output }), /unsafe/);
});

test("report JSON is untrusted data only, never an automatically approved execution", () => {
  const plan = defineOfflineJob({ sources: SAMPLES, tests: TESTS });
  const raw = JSON.stringify({
    schema: RUNNER_SCHEMA, id: plan.id, manifestHash: plan.manifestHash,
    status: "passed", exitCode: 0, elapsedMs: 400, stdout: "tests pass", stderr: ""
  });
  const parsed = parseUntrustedRunnerResult(raw, plan);
  assert.equal(parsed.status, "passed");
  assert.equal(parsed.trusted, false);
  assert.equal(parsed.requiresHumanReview, true);
  assert.throws(() => parseUntrustedRunnerResult(raw.replace(plan.manifestHash, "0".repeat(64)), plan), /invalid-runner-result/);
  assert.throws(() => parseUntrustedRunnerResult(raw.replace('"passed"', '"hacked"'), plan), /invalid-runner-result/);
  assert.throws(() => parseUntrustedRunnerResult("x".repeat(80000), plan), /invalid-runner-result-size/);
});

test("stage a sealed package and XML without launching Windows Sandbox or executing Node", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "studio-runner-contract-"));
  const runtime = path.join(base, "node.exe");
  await fs.writeFile(runtime, Buffer.alloc(1024, 0x42));
  const jobs = path.join(base, "jobs");
  await fs.mkdir(jobs);
  try {
    if (process.platform !== "win32") {
      await assert.rejects(stageOfflineRunnerJob({ stagingRoot: jobs, sources: SAMPLES, tests: TESTS, nodeExecutable: runtime }), /windows-runner-package-only/);
      return;
    }
    const packageInfo = await stageOfflineRunnerJob({
      stagingRoot: jobs, sources: SAMPLES, tests: TESTS, nodeExecutable: runtime
    });
    assert.equal(packageInfo.executionEnabled, false);
    assert.equal(packageInfo.status, "prepared-not-executed");
    const jobDir = path.join(jobs, packageInfo.id);
    const manifest = JSON.parse(await fs.readFile(path.join(jobDir, "bundle", "job.json"), "utf8"));
    assert.equal(manifest.manifestHash, packageInfo.manifestHash);
    assert.equal(await fs.readFile(path.join(jobDir, "bundle", "source", "src", "sum.mjs"), "utf8"), SAMPLES["src/sum.mjs"]);
    assert.equal(await fs.stat(path.join(jobDir, "bundle", "guest-runner.ps1")).then(x => x.isFile()), true);
    const profile = await fs.readFile(packageInfo.configPath, "utf8");
    assert.match(profile, /<Networking>Disable<\/Networking>/);
    assert.equal(await fs.readdir(packageInfo.outputDir).then(xs => xs.length), 0);
    assert.equal(await fs.readFile(runtime).then(x => x.length), 1024);
    await assert.rejects(stageOfflineRunnerJob({
      stagingRoot: jobs, sources: SAMPLES, tests: TESTS, nodeExecutable: runtime, jobId: packageInfo.id
    }));
  } finally { await fs.rm(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 60 }); }
});
