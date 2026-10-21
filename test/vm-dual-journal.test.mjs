import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {HostVmJournal} from "../src/sandbox/vm-host-coordinator.mjs";
import {DualVmOwnershipJournal} from "../src/sandbox/vm-dual-journal.mjs";
import {vmOwnershipFingerprint} from "../src/sandbox/vm-journal.mjs";
import {inspectVmRecovery,recoverStoppedVmOwnership,expectedVmRecoveryApproval} from "../src/sandbox/vm-recovery.mjs";

const SID="S-1-5-21-101-202-303-1001";
const VM1="2697ebf0-6750-4ae6-bb6e-784110dbb275";
const VM2="79a730f4-e4ed-48c0-b57c-c6f08ad2b8fa";
const JOB1="0697df14-60e4-465e-a0f1-e77a5a4a2342";
const JOB2="03fc18e7-a98d-46bc-98d8-d393e833f639";
const HASH="b".repeat(64);
const one={vmId:VM1,jobId:JOB1,manifestHash:HASH,ownerSid:SID};
const two={vmId:VM2,jobId:JOB2,manifestHash:HASH,ownerSid:SID};
const verified=async({vmId,ownerSid})=>({vmId,ownerSid,verifiedAbsent:true});

async function rig(fn,customProof=verified){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"studio-dual-owner-"));
  const machine=path.join(root,"machine");
  const jobA=path.join(root,"job-a"),jobB=path.join(root,"job-b");
  await Promise.all([fs.mkdir(machine),fs.mkdir(jobA),fs.mkdir(jobB)]);
  const attestor=async()=>({verified:true});
  const journalA=new DualVmOwnershipJournal({
    jobRoot:jobA,hostJournal:new HostVmJournal({root:machine,attestRoot:attestor}),
    verifyStopped:customProof
  });
  const journalB=new DualVmOwnershipJournal({
    jobRoot:jobB,hostJournal:new HostVmJournal({root:machine,attestRoot:attestor}),
    verifyStopped:customProof
  });
  try {await fn({root,machine,jobA,jobB,journalA,journalB});}
  finally {await fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
}
async function stopped(journal,id) {
 for(const phase of ["launch-requested","running","stopping","stopped"])
   await journal.transition(id,phase);
}

test("two independent job roots atomically admit one dual owner only",async()=>{
 await rig(async({journalA,journalB})=>{
  const outcomes=await Promise.allSettled([journalA.claim(one),journalB.claim(two)]);
  assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(outcomes.filter(x=>x.status==="rejected").length,1);
  const a=await journalA.inspect(),b=await journalB.inspect();
  assert.equal(a.active,true);assert.equal(b.active,true);
  const winner=outcomes[0].status==="fulfilled"?journalA:journalB;
  const winnerId=winner===journalA?VM1:VM2;
  assert.equal((await winner.inspect()).vmId,winnerId);
  await stopped(winner,winnerId);
  const released=await winner.releaseStopped(winnerId);
  assert.equal(released.released,true);
  assert.equal((await journalA.inspect()).active,false);
  assert.equal((await journalB.inspect()).active,false);
 });
});
test("complete successful phase transitions and two fresh stopped proofs release both locks",async()=>{
 let calls=0;
 await rig(async({journalA,journalB})=>{
  await journalA.claim(one);
  await stopped(journalA,VM1);
  assert.equal((await journalA.inspect()).status,"stopped");
  assert.equal((await journalB.inspect()).status,"partial-dual-owner");
  const result=await journalA.releaseStopped(VM1);
  assert.equal(result.released,true);
  assert.equal(calls,2);
  assert.equal((await journalA.inspect()).active,false);
  await journalB.claim(two);
  assert.equal((await journalB.inspect()).vmId,VM2);
 },async args=>{calls++;return {...args,verifiedAbsent:true};});
});
test("global reservation remains durable when local claim fails",async()=>{
 await rig(async({journalA,journalB,jobA})=>{
  await fs.mkdir(path.join(jobA,".vm-active"));
  await assert.rejects(journalA.claim(one),/local-claim-failed-global-held/);
  assert.equal((await journalA.inspect()).status,"indeterminate");
  await assert.rejects(journalB.claim(two),/occupied-requires-manual-review/);
 });
});
test("unattested global host denies claim without changing either local root",async()=>{
 await rig(async({machine,jobA})=>{
  const candidate=new DualVmOwnershipJournal({jobRoot:jobA,
   hostJournal:new HostVmJournal({root:machine,attestRoot:async()=>({verified:false})}),
   verifyStopped:verified});
  await assert.rejects(candidate.claim(one),/host-acl-and-sid-not-attested/);
  assert.equal((await fs.readdir(jobA)).length,0);
  assert.equal((await fs.readdir(machine)).length,0);
 });
});
test("missing or invalid Windows SID blocks both journal claims",async()=>{
 await rig(async({machine,journalA})=>{
  await assert.rejects(journalA.claim({...one,ownerSid:null}),/dual-vm:owner-sid-required/);
  await assert.rejects(journalA.claim({...one,ownerSid:"SYSTEM"}),/dual-vm:owner-sid-required/);
  assert.equal((await fs.readdir(machine)).length,0);
 });
});
test("unconfirmed WSB stop denies release and preserves local+global ownership",async()=>{
 await rig(async({journalA,journalB})=>{
  await journalA.claim(one);
  await stopped(journalA,VM1);
  await assert.rejects(journalA.releaseStopped(VM1),/independent-stop-proof-failed/);
  assert.equal((await journalA.inspect()).status,"stopped");
  await assert.rejects(journalB.claim(two),/occupied-requires-manual-review/);
 },async args=>({...args,verifiedAbsent:false}));
});
test("second WSB stop proof failure retains host owner after local release",async()=>{
 let calls=0;
 await rig(async({journalA,journalB})=>{
  await journalA.claim(one);
  await stopped(journalA,VM1);
  await assert.rejects(journalA.releaseStopped(VM1),/wsb-stop-not-independently-confirmed/);
  assert.equal(calls,2);
  assert.equal((await journalA.inspect()).status,"partial-dual-owner");
  await assert.rejects(journalB.claim(two),/occupied-requires-manual-review/);
 },async args=>({...args,verifiedAbsent:++calls===1}));
});
test("corrupt host record prevents subsequent lifecycle transitions or new claims",async()=>{
 await rig(async({journalA,journalB})=>{
  await journalA.claim(one);
  const file=journalA.hostJournal.recordPath;
  await fs.writeFile(file,"{malformed}");
  assert.equal((await journalA.inspect()).status,"indeterminate");
  await assert.rejects(journalA.transition(VM1,"launch-requested"));
  await assert.rejects(journalB.claim(two),/occupied-requires-manual-review/);
 });
});
test("mismatched local record identity cannot advance global state",async()=>{
 await rig(async({journalA})=>{
  await journalA.claim(one);
  const file=journalA.record;
  const record=JSON.parse(await fs.readFile(file,"utf8"));
  record.jobId=JOB2;
  await fs.writeFile(file,JSON.stringify(record));
  assert.equal((await journalA.inspect()).status,"conflicting-dual-owner");
  await assert.rejects(journalA.transition(VM1,"launch-requested"),/transition-record-mismatch/);
  assert.equal((await journalA.hostJournal.read()).phase,"reserved");
 });
});

test("host-root symlink swap after claim blocks all subsequent state changes",async()=>{
 await rig(async({journalA,machine,root})=>{
  await journalA.claim(one);
  const archive=path.join(root,"real-host-moved");
  await fs.rename(machine,archive);
  await fs.symlink(archive,machine,"dir");
  await assert.rejects(journalA.transition(VM1,"launch-requested"),
    /host-vm:unsafe-root-or-ancestor/);
  assert.equal((await journalA.inspect()).status,"indeterminate");
  await assert.rejects(journalA.releaseStopped(VM1));
  await fs.unlink(machine);
  await fs.rename(archive,machine);
  assert.equal((await journalA.inspect()).status,"reserved");
  assert.equal((await journalA.hostJournal.read()).vmId,VM1);
 });
});

test("every programmatic manual-recovery route refuses clearing only local dual ownership",async()=>{
 await rig(async({journalA,journalB})=>{
  await journalA.claim(one);
  await journalA.transition(VM1,"launch-requested");
  const originalLocal=await journalA.read();
  const originalGlobal=await journalA.hostJournal.read();
  let readinessCalls=0,listCalls=0;
  const report=await inspectVmRecovery({
    journal:journalA,
    readinessProbe:async()=>{readinessCalls++;throw Error("unreachable");},
    listVmIds:async()=>{listCalls++;throw Error("unreachable");}
  });
  assert.equal(report.active,true);
  assert.equal(report.eligible,false);
  assert.equal(report.reason,"dual-owner-recovery-broker-required");
  assert.throws(()=>expectedVmRecoveryApproval(report),
    /vm-recovery-not-approved-for-inspection/);
  await assert.rejects(journalA.releaseAfterManualRecovery({
    vmId:VM1,expectedFingerprint:vmOwnershipFingerprint(originalLocal)
  }),/dual-vm:dual-recovery-broker-not-admitted/);
  await assert.rejects(recoverStoppedVmOwnership({
    journal:journalA,approval:"forged-operator-consent",inspected:report,
    optIn:true,interactiveConfirmation:true,
    readinessProbe:async()=>{readinessCalls++;throw Error("unreachable");},
    listVmIds:async()=>{listCalls++;throw Error("unreachable");}
  }),/dual-owner-recovery-broker-required/);
  assert.equal(readinessCalls,0);
  assert.equal(listCalls,0);
  assert.deepEqual(await journalA.read(),originalLocal);
  assert.deepEqual(await journalA.hostJournal.read(),originalGlobal);
  await assert.rejects(journalB.claim(two),/occupied-requires-manual-review/);
 });
});
