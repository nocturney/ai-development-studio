import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { VmOwnershipJournal } from "../src/sandbox/vm-journal.mjs";
import {
  inspectVmRecovery, recoverStoppedVmOwnership,
  expectedVmRecoveryApproval, VM_RECOVERY_SCHEMA
} from "../src/sandbox/vm-recovery.mjs";

const VM_ID = "7f5d22c4-32b4-4e40-951c-a23e064cb289";
const JOB_ID = "f19e9921-16f3-4b31-a181-ae690bcd8351";
const HASH = "a".repeat(64);
const SID = "S-1-5-21-101-202-303-1001";
const ready = {
  platform:"win32", session:"interactive", featureReady:true,
  cliPresent:true, executable:"C:\\Windows\\System32\\wsb.exe", userSid:SID
};
const baseProbes = {
  readinessProbe:async()=>ready,
  listVmIds:async()=>new Set(),
  ownerPidAlive:async()=>false
};
const instant = async()=>{};

async function withRecord(phase, run) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "studio-vm-recovery-"));
  const journal = new VmOwnershipJournal(path.join(temp,"jobs"));
  try {
    await journal.claim({vmId:VM_ID,jobId:JOB_ID,manifestHash:HASH,ownerSid:SID});
    if (phase !== "reserved") await journal.transition(VM_ID,"launch-requested");
    if (["running","stopping","stop-unverified"].includes(phase)) {
      await journal.transition(VM_ID,"running");
    }
    if (["stopping","stop-unverified"].includes(phase)) {
      await journal.transition(VM_ID,"stopping");
    }
    if (phase === "stop-unverified") await journal.transition(VM_ID,"stop-unverified");
    await run({journal,temp});
  } finally {
    await fs.rm(temp,{recursive:true,force:true,maxRetries:4,retryDelay:80});
  }
}

test("read-only recovery inspection does not create a missing journal directory", async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"studio-vm-recovery-none-"));
  try {
    const root=path.join(temp,"jobs");
    const journal=new VmOwnershipJournal(root);
    const status=await inspectVmRecovery({journal,...baseProbes});
    assert.equal(status.schema,VM_RECOVERY_SCHEMA);
    assert.equal(status.active,false);
    assert.equal(status.reason,"no-active-ownership");
    await assert.rejects(fs.stat(root),{code:"ENOENT"});
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
});

test("session account not ready, active original PID and other VM sessions block recovery", async()=>{
  await withRecord("running",async({journal})=>{
    let queried=0;
    const unavailable=await inspectVmRecovery({journal,
      readinessProbe:async()=>({...ready,session:"service-account"}),
      listVmIds:async()=>{queried++;return new Set();}});
    assert.equal(unavailable.reason,"vm-host-unavailable");
    assert.equal(queried,0);
    const alive=await inspectVmRecovery({journal,...baseProbes,
      ownerPidAlive:async()=>true,
      listVmIds:async()=>{queried++;return new Set();}});
    assert.equal(alive.reason,"original-controller-process-still-alive");
    assert.equal(queried,0);
    const unknown=await inspectVmRecovery({journal,...baseProbes,
      ownerPidAlive:async()=>null});
    assert.equal(unknown.reason,"controller-process-status-unknown");
    const occupied=await inspectVmRecovery({journal,...baseProbes,
      listVmIds:async()=>new Set([VM_ID])});
    assert.equal(occupied.reason,"sandbox-sessions-still-present");
    assert.equal(occupied.eligible,false);
    assert.equal((await journal.inspect()).active,true);
  });
});

test("garbled owner file, malformed list and unverifiable PID all fail closed", async()=>{
  await withRecord("reserved",async({journal})=>{
    const bad=await inspectVmRecovery({journal,...baseProbes,
      listVmIds:async()=>new Set(["not-a-uuid"])});
    assert.equal(bad.reason,"invalid-vm-list");
    const failed=await inspectVmRecovery({journal,...baseProbes,
      listVmIds:async()=>{throw Error("cli-not-available");}});
    assert.equal(failed.reason,"vm-list-unavailable");
    const record=await journal.read();
    await fs.writeFile(journal.record,JSON.stringify({...record,pid:null}));
    const invalidPid=await inspectVmRecovery({journal,...baseProbes});
    assert.equal(invalidPid.reason,"unverifiable-owner-pid");
    await fs.writeFile(journal.record,"{not-json");
    const invalid=await inspectVmRecovery({journal,...baseProbes});
    assert.equal(invalid.reason,"invalid-owner-record");
    assert.equal((await journal.inspect()).active,true);
  });
});

test("typed operator approval and opt-in are mandatory; no filesystem changes when missing", async()=>{
  await withRecord("running",async({journal})=>{
    const snapshot=await inspectVmRecovery({journal,...baseProbes});
    assert.equal(snapshot.eligible,true);
    for(const overrides of [
      {optIn:false},{interactiveConfirmation:false},
      {approval:"wrong-phrase"}
    ]){
      await assert.rejects(recoverStoppedVmOwnership({
        journal,inspected:snapshot,...baseProbes,
        approval:expectedVmRecoveryApproval(snapshot),
        optIn:true,interactiveConfirmation:true,pause:instant,...overrides
      }),/explicit-vm-recovery-approval-required/);
    }
    assert.equal((await journal.inspect()).phase,undefined);
    assert.equal((await journal.inspect()).active,true);
  });
});

test("explicit recovery of an orphan in running phase releases only matching lock", async()=>{
  await withRecord("running",async({journal})=>{
    let queries=0;
    const probes={...baseProbes,listVmIds:async()=>{queries++;return new Set();}};
    const inspected=await inspectVmRecovery({journal,...probes});
    assert.equal(inspected.phase,"running");
    assert.equal(inspected.eligible,true);
    const release=await recoverStoppedVmOwnership({
      journal,inspected,approval:expectedVmRecoveryApproval(inspected),
      optIn:true,interactiveConfirmation:true,pause:instant,...probes
    });
    assert.equal(release.released,true);
    assert.equal(release.previousPhase,"running");
    assert.equal(release.confirmedEmptyVmLists,2);
    assert.equal(release.codeChangesApproved,false);
    assert.equal(queries,3);
    assert.equal((await journal.inspect()).active,false);
    await journal.claim({vmId:VM_ID,jobId:JOB_ID,manifestHash:HASH,ownerSid:SID});
    assert.equal((await journal.inspect()).active,true);
  });
});

test("stop-unverified recovery requires two new empty-list checks", async()=>{
  await withRecord("stop-unverified",async({journal})=>{
    const inspected=await inspectVmRecovery({journal,...baseProbes});
    const result=await recoverStoppedVmOwnership({
      journal,inspected,approval:expectedVmRecoveryApproval(inspected),
      optIn:true,interactiveConfirmation:true,pause:instant,...baseProbes
    });
    assert.equal(result.previousPhase,"stop-unverified");
    assert.equal((await journal.inspect()).active,false);
  });
});

test("second VM-list check showing a running sandbox leaves ownership intact", async()=>{
  await withRecord("stopping",async({journal})=>{
    let index=0;
    const probes={...baseProbes,listVmIds:async()=>++index===3?new Set([VM_ID]):new Set()};
    const inspected=await inspectVmRecovery({journal,...probes});
    await assert.rejects(recoverStoppedVmOwnership({
      journal,inspected,approval:expectedVmRecoveryApproval(inspected),
      optIn:true,interactiveConfirmation:true,pause:instant,...probes
    }),/vm-recovery-second-check-failed/);
    const record=await journal.read();
    assert.equal(record.phase,"stopping");
    assert.equal((await journal.inspect()).active,true);
  });
});

test("changed or swapped owner records cannot be cleared using old approval", async()=>{
  await withRecord("running",async({journal})=>{
    const inspected=await inspectVmRecovery({journal,...baseProbes});
    await journal.transition(VM_ID,"stopping");
    await assert.rejects(recoverStoppedVmOwnership({
      journal,inspected,approval:expectedVmRecoveryApproval(inspected),
      optIn:true,interactiveConfirmation:true,pause:instant,...baseProbes
    }),/vm-recovery-first-check-failed/);
    assert.equal((await journal.inspect()).active,true);
  });
});

test("concurrent manual recovery cannot both succeed", async()=>{
  await withRecord("stop-unverified",async({journal})=>{
    const inspected=await inspectVmRecovery({journal,...baseProbes});
    const options={
      journal,inspected,approval:expectedVmRecoveryApproval(inspected),
      optIn:true,interactiveConfirmation:true,pause:instant,...baseProbes
    };
    const results=await Promise.allSettled([
      recoverStoppedVmOwnership(options),recoverStoppedVmOwnership(options)
    ]);
    assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
    assert.equal(results.filter(x=>x.status==="rejected").length,1);
    assert.equal((await journal.inspect()).active,false);
  });
});

test("interrupted manual recovery guard prevents reinspection and new VM claims", async()=>{
  await withRecord("stop-unverified",async({journal})=>{
    const guard=path.join(journal.lock,".manual-recovery-in-progress");
    await fs.mkdir(guard);
    const status=await inspectVmRecovery({journal,...baseProbes});
    assert.equal(status.active,true);
    assert.equal(status.eligible,false);
    assert.equal(status.reason,"invalid-owner-record");
    assert.equal((await journal.inspect()).status,"indeterminate");
    await assert.rejects(journal.claim({
      vmId:VM_ID,jobId:JOB_ID,manifestHash:HASH,ownerSid:SID
    }),/vm-ownership-locked-requires-review/);
    assert.equal((await journal.read()).phase,"stop-unverified");
  });
});

test("manual recovery CLI is separate from web and denies the legacy per-job-only release", async()=>{
  const script=await fs.readFile(new URL("../scripts/manual-vm-recovery.mjs",import.meta.url),"utf8");
  const server=await fs.readFile(new URL("../src/server.mjs",import.meta.url),"utf8");
  assert.match(script,/createCanonicalWindowsHostJournal/);
  assert.match(script,/dualReleaseAllowed:false/);
  assert.match(script,/dual-owner-recovery-broker-required/);
  assert.match(script,/mutationAttempted:false/);
  assert.doesNotMatch(script,/\bawait recoverStoppedVmOwnership\(/);
  assert.doesNotMatch(server,/recoverStoppedVmOwnership/);
});

test("Windows recovery refuses another user SID even if that user's WSB list is empty", async()=>{
  await withRecord("running",async({journal})=>{
    let queries=0;
    const inspected=await inspectVmRecovery({journal,...baseProbes,
      readinessProbe:async()=>({...ready,userSid:"S-1-5-21-777-888-999-1002"}),
      listVmIds:async()=>{queries++;return new Set();}});
    assert.equal(inspected.reason,"different-windows-identity");
    assert.equal(inspected.eligible,false);
    assert.equal(queries,0);
    assert.equal((await journal.inspect()).active,true);
  });
});

test("legacy ownership without a Windows SID cannot be silently recovered", async()=>{
  await withRecord("stop-unverified",async({journal})=>{
    const old=await journal.read();
    await fs.writeFile(journal.record,JSON.stringify({...old,ownerSid:null}));
    const inspected=await inspectVmRecovery({journal,...baseProbes});
    assert.equal(inspected.reason,"legacy-owner-identity-unbound");
    assert.equal(inspected.eligible,false);
    assert.throws(()=>expectedVmRecoveryApproval(inspected));
    assert.equal((await journal.inspect()).active,true);
  });
});
