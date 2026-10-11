import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { VmOwnershipJournal } from "../src/sandbox/vm-journal.mjs";
import os from "node:os";
import path from "node:path";
import {
  probeWindowsVm, runWindowsVmJob, expectedVmApproval, VM_TEST_DRIVER,
  GUEST_RUNNER_COMMAND, parseSandboxExecAcknowledgement, parseSandboxListResponse
} from "../src/sandbox/vm-controller.mjs";

const ID = "3a2c95b6-6165-4c96-a39c-61a1d7d38c44";
const VM_ID = "55c870e1-2a40-482c-84a8-98f78acebb29";
const HASH = "a".repeat(64);
const SID = "S-1-5-21-101-202-303-1001";
const LIST_JSON = '{"WindowsSandboxEnvironments":[]}';

async function withPrepared(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-vm-controller-"));
  const outputDir = path.join(root, "output");
  await fs.mkdir(outputDir);
  const configPath = path.join(root, "job.wsb");
  await fs.writeFile(configPath, "<Configuration><Networking>Disable</Networking></Configuration>");
  const staged = {
    id: ID, manifestHash: HASH, runtimeSha256: "b".repeat(64),
    configPath, outputDir, manifest: {
      id: ID, manifestHash: HASH, timeoutSeconds: 5
    }
  };
  const calls = [];
  const fakeVM = async (binary, args) => {
    calls.push({ binary, args });
    return { stdout: args[0] === "exec" ? '{"ExitCode":0}' : args[0] === "list" ? LIST_JSON : "", stderr: "" };
  };
  const goodRecord = JSON.stringify({
    schema: "studio.runner.v1", id: ID, manifestHash: HASH,
    status: "passed", exitCode: 0, elapsedMs: 150, stdout: "tests passed", stderr: ""
  });
  const args = {
    staged, journal: new VmOwnershipJournal(path.join(root, "jobs")),
    approval: expectedVmApproval(staged), executionOptIn: true,
    interactiveConfirmation: true, vmId: VM_ID, startupGraceMs: 1000, guestBootWaitMs: 0,
    readinessProbe: async () => ({
      schema: VM_TEST_DRIVER, platform: "win32", session: "interactive",
      cliPresent: true, featureReady: true, userSid: SID, executable: "C:\\Windows\\System32\\wsb.exe"
    }),
    preflight: async () => ({
      id: ID, manifestHash: HASH, verified: true, executionEnabled: false
    }),
    reportReader: async () => goodRecord,
    vmCommand: fakeVM
  };
  try { await run({ staged, args, calls, goodRecord }); }
  finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); }
}

test("vm capability probe never enables Sandbox and rejects service account", async () => {
  let queried = 0;
  const result = await probeWindowsVm({
    platform: "win32", username: "NT AUTHORITY\\SYSTEM",
    sessionProbe: async () => { queried++; return 1; },
    executableProbe: async () => { queried++; return true; }
  });
  assert.equal(result.featureReady, false);
  assert.equal(result.executionEnabled, false);
  assert.equal(result.reason, "interactive-user-required");
  assert.equal(queried, 0);
});

test("vm probe enforces enabled feature, active user session, and known CLI", async () => {
  const base = {
    platform: "win32", username: "Chris", sessionProbe: async () => 2,
    executableProbe: async () => true, identityProbe: async () => SID
  };
  const disabled = await probeWindowsVm({
    ...base, featureProbe: async () => ({ featureState: "Disabled" })
  });
  assert.equal(disabled.featureReady, false);
  assert.equal(disabled.reason, "windows-sandbox-feature-not-enabled");
  const noSession = await probeWindowsVm({ ...base, sessionProbe: async () => 0 });
  assert.equal(noSession.reason, "interactive-session-required");
  const noBinary = await probeWindowsVm({
    ...base, executableProbe: async () => false,
    featureProbe: async () => ({ featureState: "Enabled" })
  });
  assert.equal(noBinary.reason, "sandbox-cli-not-installed");
  const ready = await probeWindowsVm({
    ...base, featureProbe: async () => ({ featureState: "Enabled" })
  });
  assert.equal(ready.featureReady, true);
  assert.equal(ready.executionEnabled, false);
  assert.equal(ready.reason, "explicit-approval-required");
});

test("unknown platform is denied before any host feature query", async () => {
  let queries = 0;
  const state = await probeWindowsVm({
    platform: "darwin", username: "Chris",
    featureProbe: async () => { queries++; throw Error("unexpected"); }
  });
  assert.equal(state.reason, "windows-only");
  assert.equal(queries, 0);
});

test("no vm command is invoked without per-job consent, interactive confirmation and opt-in", async () => {
  await withPrepared(async ({ args, calls }) => {
    for (const override of [
      { executionOptIn: false }, { interactiveConfirmation: false },
      { approval: "RUN OFFLINE VM JOB other" }
    ]) {
      await assert.rejects(runWindowsVmJob({ ...args, ...override }), /explicit-vm-approval-required/);
    }
    assert.equal(calls.length, 0);
  });
});

test("safe driver starts exact configured VM, accepts only untrusted result and stops VM", async () => {
  await withPrepared(async ({ args, calls }) => {
    const result = await runWindowsVmJob(args);
    assert.equal(result.vmId, VM_ID);
    assert.equal(result.status, "passed");
    assert.equal(result.trusted, false);
    assert.equal(result.sandboxStopped, true);
    assert.equal(result.requiresHumanReview, true);
    assert.equal(result.acceptedForAutomaticApproval, false);
    assert.deepEqual(calls.map(x => x.args.slice(0, 2)), [["start", "--id"], ["exec", "--id"], ["stop", "--id"], ["list", "--raw"]]);
    assert.equal(calls[0].args[2], VM_ID);
    assert.equal(calls[0].args[3], "--config");
    assert.ok(calls[0].args[4].includes("<Networking>Disable</Networking>"));
    assert.deepEqual(calls[1].args, ["exec", "--id", VM_ID, "--command", GUEST_RUNNER_COMMAND, "--run-as", "System", "--raw"]);
    assert.deepEqual(calls[2].args, ["stop", "--id", VM_ID]);
    assert.deepEqual(calls[3].args, ["list", "--raw"]);
    assert.equal(calls[0].binary, "C:\\Windows\\System32\\wsb.exe");
  });
});

test("staging tampering or inaccurate preflight blocks VM start", async () => {
  await withPrepared(async ({ args, calls }) => {
    await assert.rejects(runWindowsVmJob({
      ...args, preflight: async () => ({ verified: false })
    }), /runner-preflight-not-verified/);
    await assert.rejects(runWindowsVmJob({
      ...args, staged: { ...args.staged, outputDir: "C:\\unrelated" }
    }), /untrusted-job-paths/);
    assert.equal(calls.length, 0);
  });
});

test("untrusted malformed guest result fails and still stops sandbox", async () => {
  await withPrepared(async ({ args, calls }) => {
    await assert.rejects(runWindowsVmJob({
      ...args, reportReader: async () => JSON.stringify({ status: "passed", stdout: "fake" })
    }), /invalid-runner-result/);
    assert.deepEqual(calls.map(x => x.args[0]), ["start", "exec", "stop", "list"]);
  });
});

test("timed-out guest report forces VM stop and never returns success", async () => {
  await withPrepared(async ({ args, calls }) => {
    let time = 0;
    await assert.rejects(runWindowsVmJob({
      ...args, pollMs: 100, now: () => time,
      wait: async ms => { time += ms; },
      reportReader: async () => null
    }), /vm-guest-report-timeout/);
    assert.deepEqual(calls.map(x => x.args[0]), ["start", "exec", "stop", "list"]);
  });
});

test("abort while polling requests sandbox termination", async () => {
  await withPrepared(async ({ args, calls }) => {
    const controller = new AbortController();
    await assert.rejects(runWindowsVmJob({
      ...args, signal: controller.signal,
      reportReader: async () => null,
      wait: async () => {
        controller.abort(new DOMException("operator-cancelled", "AbortError"));
        controller.signal.throwIfAborted();
      }
    }), /operator-cancelled/);
    assert.deepEqual(calls.map(x => x.args[0]), ["start", "exec", "stop", "list"]);
  });
});

test("start failure is followed by best-effort stop of known VM ID", async () => {
  await withPrepared(async ({ args, calls }) => {
    await assert.rejects(runWindowsVmJob({
      ...args, vmCommand: async (binary, arguments_) => {
        calls.push({ binary, args: arguments_ });
        if (arguments_[0] === "start") throw Error("simulated-boot-failure");
        return { stdout: arguments_[0] === "list" ? LIST_JSON : "" };
      }
    }), /simulated-boot-failure/);
    assert.deepEqual(calls.map(x => x.args[0]), ["start", "stop", "list"]);
  });
});

test("cannot claim completion when VM stop confirmation fails", async () => {
  await withPrepared(async ({ args }) => {
    await assert.rejects(runWindowsVmJob({
      ...args,
      vmCommand: async (binary, commandArgs) => {
        if (commandArgs[0] === "stop") throw Error("simulated-stop-failure");
        return { stdout: commandArgs[0] === "exec" ? '{"ExitCode":0}' : commandArgs[0] === "list" ? LIST_JSON : "" };
      }
    }), /vm-stop-not-confirmed/);
  });
});

test("simultaneous job and stop failure retains both causes", async () => {
  await withPrepared(async ({ args }) => {
    await assert.rejects(runWindowsVmJob({
      ...args,
      vmCommand: async () => { throw Error("broken-vm-cli"); }
    }), error => error instanceof AggregateError && error.errors.length === 2);
  });
});

test("event callback failure never prevents VM stop or truthful result", async () => {
  await withPrepared(async ({ args, calls }) => {
    const result = await runWindowsVmJob({
      ...args,
      onEvent: () => { throw Error("unreliable-UI-listener"); }
    });
    assert.equal(result.sandboxStopped, true);
    assert.deepEqual(calls.map(c => c.args[0]), ["start", "exec", "stop", "list"]);
  });
});

test("an inconsistent staged manifest is rejected before invoking Sandbox", async () => {
  await withPrepared(async ({ args, calls }) => {
    await assert.rejects(runWindowsVmJob({
      ...args,
      staged: { ...args.staged, manifest: { ...args.staged.manifest, id: VM_ID } }
    }), /inconsistent-staged-manifest/);
    assert.deepEqual(calls, []);
  });
});

test("real result-file reader consumes staged result without trusting the guest", async () => {
  await withPrepared(async ({ args, calls, goodRecord }) => {
    const { reportReader, ...rest } = args;
    const result = await runWindowsVmJob({
      ...rest,
      vmCommand: async (exe, argv) => {
        calls.push({ binary: exe, args: argv });
        if (argv[0] === "exec") {
          await fs.writeFile(path.join(args.staged.outputDir, "result.json"), goodRecord);
        }
        return { stdout: argv[0] === "exec" ? '{"ExitCode":0}' : argv[0] === "list" ? LIST_JSON : "" };
      }
    });
    assert.equal(result.status, "passed");
    assert.equal(result.trusted, false);
    assert.equal(result.sandboxStopped, true);
    assert.deepEqual(calls.map(c => c.args[0]), ["start", "exec", "stop", "list"]);
  });
});

test("result-size violation is rejected and still triggers VM stop", async () => {
  await withPrepared(async ({ args, calls }) => {
    const { reportReader, ...rest } = args;
    await assert.rejects(runWindowsVmJob({
      ...rest,
      vmCommand: async (exe, argv) => {
        calls.push({ binary: exe, args: argv });
        if (argv[0] === "exec") {
          await fs.writeFile(path.join(args.staged.outputDir, "result.json"), "X".repeat(70001));
        }
        return { stdout: argv[0] === "exec" ? '{"ExitCode":0}' : argv[0] === "list" ? LIST_JSON : "" };
      }
    }), /unsafe-vm-result/);
    assert.deepEqual(calls.map(c => c.args[0]), ["start", "exec", "stop", "list"]);
  });
});

test("any VM execution entrypoint must supply a durable ownership journal", async () => {
  await withPrepared(async ({ args, calls }) => {
    await assert.rejects(runWindowsVmJob({ ...args, journal: null }),
      /vm-ownership-journal-required/);
    assert.equal(calls.length, 0);
  });
});

test("Sandbox exec CLI acknowledgement must be parseable, bounded and successful", () => {
  assert.equal(parseSandboxExecAcknowledgement('{"ExitCode":0}'), 0);
  for (const raw of ["", "success", "{}", "[]", '{"ExitCode":"0"}',
    '{"ExitCode":-1}', '{"ExitCode":256}', "x".repeat(2100)]) {
    assert.throws(() => parseSandboxExecAcknowledgement(raw), /invalid-sandbox-exec-response/);
  }
  assert.throws(() => parseSandboxExecAcknowledgement('{"ExitCode":7}'),
    /sandbox-guest-command-failed/);
});

test("nonzero CLI guest exit is fatal and VM is stopped without trusting guest report", async () => {
  await withPrepared(async ({ args, calls }) => {
    await assert.rejects(runWindowsVmJob({
      ...args, vmCommand: async (exe, argv) => {
        calls.push({ binary: exe, args: argv });
        return { stdout: argv[0] === "exec" ? '{"ExitCode":1}' : argv[0] === "list" ? LIST_JSON : "" };
      }
    }), /sandbox-guest-command-failed/);
    assert.deepEqual(calls.map(c => c.args[0]), ["start", "exec", "stop", "list"]);
    assert.equal((await args.journal.inspect()).active, false);
  });
});

test("ambiguous VM exec CLI failure is not retried or auto-approved", async () => {
  await withPrepared(async ({ args, calls }) => {
    await assert.rejects(runWindowsVmJob({
      ...args, vmCommand: async (exe, argv) => {
        calls.push({ binary: exe, args: argv });
        if (argv[0] === "exec") throw Error("cli-execution-not-confirmed");
        return { stdout: argv[0] === "list" ? LIST_JSON : "" };
      }
    }), /cli-execution-not-confirmed/);
    assert.deepEqual(calls.map(c => c.args[0]), ["start", "exec", "stop", "list"]);
  });
});

test("cancellation before guest exec never launches guest command and requests VM stop", async () => {
  await withPrepared(async ({ args, calls }) => {
    const controller = new AbortController();
    await assert.rejects(runWindowsVmJob({
      ...args, signal: controller.signal, guestBootWaitMs: 100,
      wait: async () => {
        controller.abort(new DOMException("cancel-before-guest-exec", "AbortError"));
        controller.signal.throwIfAborted();
      }
    }), /cancel-before-guest-exec/);
    assert.deepEqual(calls.map(c => c.args[0]), ["start", "stop", "list"]);
  });
});

test("WSB list JSON is bounded and validates VM identifiers before trusting stop", () => {
  assert.deepEqual([...parseSandboxListResponse(LIST_JSON)], []);
  const occupied = JSON.stringify({WindowsSandboxEnvironments: [{Id: VM_ID}]});
  assert.equal(parseSandboxListResponse(occupied).has(VM_ID.toLowerCase()), true);
  for (const invalid of ["", "null", "{}", "[]",
    '{"WindowsSandboxEnvironments":[{"Id":"not-a-vm-id"}]}',
    "x".repeat(21000)]) {
    assert.throws(() => parseSandboxListResponse(invalid), /invalid-sandbox-list-response/);
  }
});

test("WSB stop exit 0 is insufficient if the same VM remains listed", async () => {
  await withPrepared(async ({ args, calls }) => {
    const occupied = JSON.stringify({WindowsSandboxEnvironments: [{Id: VM_ID}]});
    await assert.rejects(runWindowsVmJob({
      ...args,
      wait: async () => {},
      vmCommand: async (exe, argv) => {
        calls.push({ binary: exe, args: argv });
        return {stdout: argv[0] === "exec" ? '{"ExitCode":0}' :
          argv[0] === "list" ? occupied : "" };
      }
    }), /vm-stop-not-confirmed/);
    assert.deepEqual(calls.map(x => x.args[0]),
      ["start", "exec", "stop", "list", "list", "list"]);
    const journal = await args.journal.inspect();
    assert.equal(journal.status, "stop-unverified");
    assert.equal(journal.vmId, VM_ID);
  });
});

test("invalid WSB list JSON keeps VM ownership locked for inspection", async () => {
  await withPrepared(async ({ args }) => {
    await assert.rejects(runWindowsVmJob({
      ...args,
      vmCommand: async (exe, argv) =>
        ({stdout: argv[0] === "exec" ? '{"ExitCode":0}' :
          argv[0] === "list" ? "not-json" : ""})
    }), /vm-stop-not-confirmed/);
    assert.equal((await args.journal.inspect()).status, "stop-unverified");
  });
});

test("the VM journal is bound to the verified Windows owner SID before launch", async()=>{
  await withPrepared(async({args})=>{
    let observedSid=null;
    await runWindowsVmJob({
      ...args,
      vmCommand:async(executable,argv)=>{
        if(argv[0]==="start") {
          const owner=await args.journal.read();
          observedSid=owner.ownerSid;
        }
        return {stdout:argv[0]==="exec"?'{"ExitCode":0}':
          argv[0]==="list"?LIST_JSON:""};
      }
    });
    assert.equal(observedSid,SID);
    assert.equal((await args.journal.inspect()).active,false);
  });
});

test("the VM driver refuses unidentified operators before creating any journal",async()=>{
  await withPrepared(async({args,calls})=>{
    await assert.rejects(runWindowsVmJob({
      ...args,
      readinessProbe:async()=>({
        featureReady:true,platform:"win32",session:"interactive",
        cliPresent:true,executable:"C:\\Windows\\System32\\wsb.exe",
        userSid:null
      })
    }),/vm-operator-windows-sid-required/);
    assert.deepEqual(calls,[]);
    assert.equal((await args.journal.inspect()).active,false);
  });
});
