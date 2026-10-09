import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stageOfflineRunnerJob, verifyPreparedOfflineRunnerJob } from "../src/sandbox/offline-runner.mjs";

const sources = {
  "src/sum.mjs": "export const sum=(a,b)=>a+b;\n",
  "test/sum.test.mjs": "import test from 'node:test';test('sum',()=>{});\n"
};
const tests = ["test/sum.test.mjs"];

async function stageScenario(callback) {
  if (process.platform !== "win32") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-sealed-"));
  const jobs = path.join(root, "jobs");
  await fs.mkdir(jobs);
  const binary = path.join(root, "node.exe");
  await fs.writeFile(binary, Buffer.alloc(1024, 0x42));
  try {
    const staged = await stageOfflineRunnerJob({
      stagingRoot: jobs, sources, tests, nodeExecutable: binary
    });
    const jobRoot = path.join(jobs, staged.id);
    const args = {
      jobRoot, expectedManifestHash: staged.manifestHash,
      expectedRuntimeSha256: staged.runtimeSha256
    };
    await callback({ jobRoot, staged, args });
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}

test("preflight seals prepared inputs without launching an executor", async () => {
  await stageScenario(async ({ args, staged }) => {
    const result = await verifyPreparedOfflineRunnerJob(args);
    assert.equal(result.verified, true);
    assert.equal(result.executionEnabled, false);
    assert.equal(result.status, "sealed-not-executed");
    assert.equal(result.id, staged.id);
  });
});

test("preflight refuses edits to staged source", async () => {
  await stageScenario(async ({ args, jobRoot }) => {
    await fs.appendFile(path.join(jobRoot, "bundle", "source", "src", "sum.mjs"), "evil");
    await assert.rejects(verifyPreparedOfflineRunnerJob(args), /runner-source-tampered/);
  });
});

test("preflight refuses guest script and vm profile modifications", async () => {
  await stageScenario(async ({ args, jobRoot }) => {
    const guest = path.join(jobRoot, "bundle", "guest-runner.ps1");
    await fs.appendFile(guest, "# modified");
    await assert.rejects(verifyPreparedOfflineRunnerJob(args), /runner-guest-script-tampered/);
  });
  await stageScenario(async ({ args, jobRoot }) => {
    await fs.appendFile(path.join(jobRoot, "job.wsb"), "<Networking>Enable</Networking>");
    await assert.rejects(verifyPreparedOfflineRunnerJob(args), /runner-profile-tampered/);
  });
});

test("preflight refuses compromised manifest and runtime", async () => {
  await stageScenario(async ({ args, jobRoot }) => {
    const manifest = path.join(jobRoot, "bundle", "job.json");
    const data = JSON.parse(await fs.readFile(manifest, "utf8"));
    data.timeoutSeconds = 120;
    await fs.writeFile(manifest, JSON.stringify(data));
    await assert.rejects(verifyPreparedOfflineRunnerJob(args), /runner-manifest-integrity-failed/);
  });
  await stageScenario(async ({ args, jobRoot }) => {
    await fs.appendFile(path.join(jobRoot, "bundle", "node.exe"), "x");
    await assert.rejects(verifyPreparedOfflineRunnerJob(args), /runner-runtime-integrity-failed/);
  });
});

test("preflight refuses existing results and malformed expected hashes", async () => {
  await stageScenario(async ({ args, jobRoot }) => {
    await fs.writeFile(path.join(jobRoot, "output", "result.json"), "{}");
    await assert.rejects(verifyPreparedOfflineRunnerJob(args), /runner-output-directory-not-empty/);
    await assert.rejects(verifyPreparedOfflineRunnerJob({ ...args, expectedManifestHash: "wrong" }), /invalid-runner-preflight-arguments/);
  });
});

test("preflight denies unexpected source files even if listed files are unmodified", async () => {
  await stageScenario(async ({ args, jobRoot }) => {
    await fs.writeFile(path.join(jobRoot, "bundle", "source", "extra.mjs"), "console.log('not permitted')");
    await assert.rejects(verifyPreparedOfflineRunnerJob(args), /runner-unexpected-source-files/);
  });
});
