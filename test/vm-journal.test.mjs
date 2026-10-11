import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VmOwnershipJournal } from "../src/sandbox/vm-journal.mjs";
import { runWindowsVmJob, expectedVmApproval } from "../src/sandbox/vm-controller.mjs";

const JOB_ID = "24a8e2b5-6c01-49d0-b0c9-144cf924113f";
const VM_ID = "00c55d38-4270-4c6a-8c07-27e6a444d4a2";
const HASH = "a".repeat(64);
const SID = "S-1-5-21-101-202-303-1001";
const LIST_JSON = '{"WindowsSandboxEnvironments":[]}';

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-vm-owner-"));
  const jobs = path.join(root, "jobs");
  const journal = new VmOwnershipJournal(jobs);
  try { await run({ root, jobs, journal }); }
  finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 }); }
}

async function claim(journal) {
  return journal.claim({ vmId: VM_ID, jobId: JOB_ID, manifestHash: HASH });
}

test("journal inspection is read-only and creates no directories", async () => {
  await fixture(async ({ jobs, journal }) => {
    assert.deepEqual(await journal.inspect(), { active: false, status: "no-history" });
    await assert.rejects(fs.stat(jobs), { code: "ENOENT" });
  });
});

test("journal tracks one VM across startup, run, stopping and confirmed cleanup", async () => {
  await fixture(async ({ jobs, journal }) => {
    await claim(journal);
    const next = new VmOwnershipJournal(jobs);
    assert.equal((await next.inspect()).vmId, VM_ID);
    await assert.rejects(claim(next), /vm-ownership-locked-requires-review/);
    for (const phase of ["launch-requested", "running", "stopping", "stopped"]) {
      const record = await next.transition(VM_ID, phase);
      assert.equal(record.phase, phase);
    }
    await assert.rejects(next.transition(VM_ID, "running"), /invalid-vm-owner-transition/);
    assert.equal((await next.releaseStopped(VM_ID)).released, true);
    assert.equal((await journal.inspect()).active, false);
  });
});

test("release requires positive stop confirmation and matching VM identity", async () => {
  await fixture(async ({ journal }) => {
    await claim(journal);
    await assert.rejects(journal.releaseStopped(VM_ID), /vm-stop-not-recorded/);
    await assert.rejects(journal.transition(JOB_ID, "launch-requested"), /invalid-vm-owner-transition/);
    await journal.transition(VM_ID, "launch-requested");
    await journal.transition(VM_ID, "running");
    await journal.transition(VM_ID, "stop-unverified");
    assert.equal((await journal.inspect()).status, "stop-unverified");
    await assert.rejects(journal.releaseStopped(VM_ID), /vm-stop-not-recorded/);
    await assert.rejects(claim(journal), /vm-ownership-locked-requires-review/);
  });
});

test("crash leaves ownership record readable without silently stopping or unlocking VM", async () => {
  await fixture(async ({ jobs, journal }) => {
    await claim(journal);
    await journal.transition(VM_ID, "launch-requested");
    // The original controller process is gone; a new one inspects the durable state.
    const replacement = new VmOwnershipJournal(jobs);
    const active = await replacement.inspect();
    assert.equal(active.active, true);
    assert.equal(active.status, "launch-requested");
    assert.equal(active.requiresManualReview, true);
    await assert.rejects(claim(replacement), /vm-ownership-locked-requires-review/);
    // Simulated operator confirms no VM exists, then marks it stopped.
    await replacement.transition(VM_ID, "stopped");
    await replacement.releaseStopped(VM_ID);
  });
});

test("incomplete or corrupted record is indeterminate, not silently removed", async () => {
  await fixture(async ({ journal }) => {
    await claim(journal);
    await fs.writeFile(journal.record, "{ broken JSON");
    const outcome = await journal.inspect();
    assert.equal(outcome.active, true);
    assert.equal(outcome.status, "indeterminate");
    await assert.rejects(claim(journal), /vm-ownership-locked-requires-review/);
  });
});

test("parallel journal acquisition permits exactly one controller", async () => {
  await fixture(async ({ jobs }) => {
    const first = new VmOwnershipJournal(jobs);
    const second = new VmOwnershipJournal(jobs);
    const result = await Promise.allSettled([claim(first), claim(second)]);
    assert.equal(result.filter(x => x.status === "fulfilled").length, 1);
    assert.equal(result.filter(x => x.status === "rejected").length, 1);
    const owner = new VmOwnershipJournal(jobs);
    await owner.transition(VM_ID, "stopped");
    await owner.releaseStopped(VM_ID);
  });
});

async function withSimulatedVM(run) {
  await fixture(async ({ root, journal }) => {
    const outputDir = path.join(root, "output");
    await fs.mkdir(outputDir);
    const configPath = path.join(root, "job.wsb");
    await fs.writeFile(configPath, "<Configuration><Networking>Disable</Networking></Configuration>");
    const staged = {
      id: JOB_ID, manifestHash: HASH, runtimeSha256: "b".repeat(64),
      configPath, outputDir,
      manifest: { id: JOB_ID, manifestHash: HASH, timeoutSeconds: 5 }
    };
    const record = JSON.stringify({
      schema: "studio.runner.v1", id: JOB_ID, manifestHash: HASH,
      status: "passed", exitCode: 0, elapsedMs: 123,
      stdout: "test completed", stderr: ""
    });
    const calls = [];
    const args = {
      staged, journal, vmId: VM_ID,
      approval: expectedVmApproval(staged),
      executionOptIn: true, interactiveConfirmation: true, guestBootWaitMs: 0,
      readinessProbe: async () => ({
        featureReady: true, platform: "win32", session: "interactive",
        cliPresent: true, userSid: SID, executable: "C:\\Windows\\System32\\wsb.exe"
      }),
      preflight: async () => ({ id: JOB_ID, manifestHash: HASH, verified: true, executionEnabled: false }),
      reportReader: async () => record,
      vmCommand: async (exe, argv) => {
        calls.push(argv[0]);
        return { stdout: argv[0] === "exec" ? '{"ExitCode":0}' : argv[0] === "list" ? LIST_JSON : "", stderr: "" };
      }
    };
    await run({ journal, staged, args, calls });
  });
}

test("VM controller reserves and releases persistent ownership after successful stop", async () => {
  await withSimulatedVM(async ({ args, journal, calls }) => {
    const result = await runWindowsVmJob(args);
    assert.equal(result.sandboxStopped, true);
    assert.deepEqual(calls, ["start", "exec", "stop", "list"]);
    assert.equal((await journal.inspect()).active, false);
  });
});

test("stop failure leaves durable VM identifier for manual recovery", async () => {
  await withSimulatedVM(async ({ args, journal, calls }) => {
    await assert.rejects(runWindowsVmJob({
      ...args,
      vmCommand: async (exe, argv) => {
        calls.push(argv[0]);
        if (argv[0] === "stop") throw Error("vm-stop-failed");
        return { stdout: argv[0] === "exec" ? '{"ExitCode":0}' : argv[0] === "list" ? LIST_JSON : "" };
      }
    }), /vm-stop-not-confirmed/);
    const info = await journal.inspect();
    assert.equal(info.status, "stop-unverified");
    assert.equal(info.vmId, VM_ID);
    assert.deepEqual(calls, ["start", "exec", "stop"]);
    await assert.rejects(claim(journal), /vm-ownership-locked-requires-review/);
  });
});

test("cancelled VM run still stops and releases journal when stop succeeds", async () => {
  await withSimulatedVM(async ({ args, journal, calls }) => {
    const abort = new AbortController();
    await assert.rejects(runWindowsVmJob({
      ...args, signal: abort.signal,
      reportReader: async () => {
        abort.abort(new DOMException("cancelled-for-test", "AbortError"));
        abort.signal.throwIfAborted();
      }
    }), /cancelled-for-test/);
    assert.deepEqual(calls, ["start", "exec", "stop", "list"]);
    assert.equal((await journal.inspect()).active, false);
  });
});

test("failed journal claim prevents any Sandbox command", async () => {
  await withSimulatedVM(async ({ args, journal, calls }) => {
    await claim(journal);
    await assert.rejects(runWindowsVmJob(args), /vm-ownership-locked-requires-review/);
    assert.equal(calls.length, 0);
  });
});
