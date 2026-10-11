import test from "node:test";
import assert from "node:assert/strict";
import { manualVmExitStatus } from "../src/sandbox/vm-controller.mjs";

const successfulGuest = {
  status: "passed", exitCode: 0, sandboxStopped: true,
  trusted: false, requiresHumanReview: true, acceptedForAutomaticApproval: false
};

test("manual VM terminal reports success only for reviewed-and-stopped passing guest", () => {
  assert.equal(manualVmExitStatus(successfulGuest), 0);
});

test("failed, timed out and crashed guest results exit nonzero even after verified stop", () => {
  for (const [status, exitCode] of [
    ["failed",1],["failed",17],["timeout",-1],["error",-1]
  ]) {
    assert.equal(manualVmExitStatus({...successfulGuest,status,exitCode}),2);
  }
});

test("malformed and inconsistent guest success claims cannot exit zero", () => {
  for(const change of [
    { exitCode:1 }, { sandboxStopped:false }, {trusted:true},
    {requiresHumanReview:false}, {acceptedForAutomaticApproval:true},
    {status:"passed", exitCode:-1}, { status:undefined },
    { acceptedForAutomaticApproval:undefined }
  ]) {
    assert.equal(manualVmExitStatus({...successfulGuest,...change}),2);
  }
  for (const value of [null,undefined,{},0,"passed",[]]) {
    assert.equal(manualVmExitStatus(value),2);
  }
});

test("manual CLI uses fail-closed outcome classifier for terminal exit code", async () => {
  const fs=await import("node:fs/promises");
  const path=await import("node:path");
  const {fileURLToPath}=await import("node:url");
  const script=await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),"../scripts/manual-vm-runner.mjs"),"utf8");
  assert.match(script,/process\.exitCode\s*=\s*manualVmExitStatus\(outcome\)/);
  assert.match(script,/interactiveConfirmation:\s*true/);
  assert.match(script,/executionOptIn:\s*process\.env\.STUDIO_ALLOW_VM_EXECUTION\s*===\s*"1"/);
});
