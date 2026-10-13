import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {HostVmJournal, WINDOWS_VM_HOST_ROOT} from "../src/sandbox/vm-host-coordinator.mjs";

const ID1="75ac3cb5-68aa-449c-952e-71f6bcb57c18";
const ID2="c76d27a5-bac9-4687-a7e6-76e61bd1db0c";
const JOB1="27f17084-8b68-4c16-9de5-29ebd78f3658";
const JOB2="c55912b9-3963-4226-a5d4-d63be4faf599";
const SHA="a".repeat(64), SID="S-1-5-21-100-200-300-1001";
const BAD_SID="S-1-5-21-100-200-300-2222";
const YES=async()=>({verified:true});
const NO=async()=>({verified:false});
async function fixture(run){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),"studio-host-vm-"));
 const shared=path.join(base,"trusted-machine-owned");
 const rootA=path.join(base,"jobs-a"), rootB=path.join(base,"jobs-b");
 await fs.mkdir(shared);
 await fs.mkdir(rootA);
 await fs.mkdir(rootB);
 const first=new HostVmJournal({root:shared,attestRoot:YES});
 const second=new HostVmJournal({root:shared,attestRoot:YES});
 const one={vmId:ID1,jobId:JOB1,manifestHash:SHA,ownerSid:SID,jobJournalRoot:rootA};
 const two={vmId:ID2,jobId:JOB2,manifestHash:SHA,ownerSid:SID,jobJournalRoot:rootB};
 try{await run({base,shared,rootA,rootB,first,second,one,two});}
 finally{await fs.rm(base,{recursive:true,force:true,maxRetries:2,retryDelay:40});}
}
const free=jobRoot=>({root:jobRoot,inspect:async()=>({active:false,status:"none"})});
const proof=async()=>({vmId:ID1,ownerSid:SID,verifiedAbsent:true});
async function advance(journal,phase){
 for(const stage of ["launch-requested","running","stopping","stopped"]){
  await journal.transition(ID1,stage,SID);
  if(stage===phase)break;
 }
}

test("canonical production path cannot be redirected by per-job environment variables",()=>{
 assert.equal(WINDOWS_VM_HOST_ROOT,"C:\\ProgramData\\AIStudio\\VmOwner");
 assert.ok(!WINDOWS_VM_HOST_ROOT.includes("SandboxJobs"));
 assert.ok(!WINDOWS_VM_HOST_ROOT.startsWith("D:\\"));
});
test("missing coordination root fails closed without creating any path",async()=>{
 const root=path.join(os.tmpdir(),"absent-"+process.pid+"-"+Date.now());
 const lock=new HostVmJournal({root,attestRoot:YES});
 const job=path.join(os.tmpdir(),"safe-test-jobs");
 await assert.rejects(lock.claim({vmId:ID1,jobId:JOB1,manifestHash:SHA,ownerSid:SID,jobJournalRoot:job}),/root-unavailable/);
 assert.equal((await lock.inspect()).status,"indeterminate");
 await assert.rejects(fs.lstat(root),{code:"ENOENT"});
});
test("root is not considered provisioned without independent ACL/SID attestation",async()=>{
 await fixture(async({shared,one})=>{
  const lock=new HostVmJournal({root:shared,attestRoot:NO});
  await assert.rejects(lock.claim(one),/not-attested/);
  assert.equal((await fs.readdir(shared)).length,0);
  const defaultDeny=new HostVmJournal({root:shared});
  await assert.rejects(defaultDeny.claim(one),/not-attested/);
 });
});
test("two simultaneous callers from different job roots get one host-wide owner",async()=>{
 await fixture(async({first,second,one,two})=>{
  const outcomes=await Promise.allSettled([first.claim(one),second.claim(two)]);
  assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(outcomes.filter(x=>x.status==="rejected").length,1);
  const owner=await first.read();
  assert.ok([one.jobJournalRoot,two.jobJournalRoot].includes(owner.jobJournalRoot));
  assert.equal((await second.inspect()).active,true);
  await assert.rejects(first.claim(two),/occupied-requires-manual-review/);
 });
});
test("same PID, separate HostVmJournal objects cannot race a phase and orphan temp records",async()=>{
  await fixture(async({first,second,one})=>{
    await first.claim(one);
    const outcomes=await Promise.allSettled([
      first.transition(ID1,"launch-requested",SID),
      second.transition(ID1,"launch-requested",SID)
    ]);
    assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1);
    const blocked=outcomes.filter(x=>x.status==="rejected");
    assert.equal(blocked.length,1);
    assert.match(String(blocked[0].reason),/host-vm:transition-in-progress/);
    assert.equal((await first.read()).phase,"launch-requested");
    assert.deepEqual(await fs.readdir(first.lock),["owner.json"]);
    await second.transition(ID1,"running",SID);
    assert.equal((await first.inspect()).status,"running");
  });
});

test("no second owner after interrupted mkdir-before-record crash",async()=>{
 await fixture(async({first,shared,two})=>{
  await fs.mkdir(path.join(shared,".vm-host-active"));
  assert.equal((await first.inspect()).status,"indeterminate");
  await assert.rejects(first.claim(two),/occupied-requires-manual-review/);
 });
});
test("corrupt or extra record content remains fail-closed and cannot be overwritten",async()=>{
 await fixture(async({first,second,one,two})=>{
  await first.claim(one);
  await fs.writeFile(first.recordPath,"{corrupt-json");
  assert.equal((await second.inspect()).status,"indeterminate");
  await assert.rejects(second.claim(two),/occupied-requires-manual-review/);
  await fs.writeFile(first.recordPath,"{}");
  await fs.writeFile(path.join(first.lock,"unknown.tmp"),"partial");
  assert.equal((await first.inspect()).status,"indeterminate");
 });
});
test("wrong SID, VM UUID or illegal phases cannot alter durable host owner",async()=>{
 await fixture(async({first,one})=>{
  await first.claim(one);
  await assert.rejects(first.transition(ID2,"launch-requested",SID),/invalid-transition/);
  await assert.rejects(first.transition(ID1,"running",SID),/invalid-transition/);
  await assert.rejects(first.transition(ID1,"launch-requested",BAD_SID),/invalid-transition/);
  assert.equal((await first.read()).phase,"reserved");
 });
});
test("unverified stop and active per-job journal block release",async()=>{
 await fixture(async({first,one,rootA})=>{
  await first.claim(one);
  await first.transition(ID1,"launch-requested",SID);
  await first.transition(ID1,"running",SID);
  await first.transition(ID1,"stop-unverified",SID);
  await assert.rejects(first.releaseAfterVerifiedStop({vmId:ID1,ownerSid:SID,jobJournal:free(rootA),verifyStopped:proof}),/not-releasable/);
  assert.equal((await first.inspect()).status,"stop-unverified");
 });
});
test("global stopped phase is insufficient without absent local and confirmed WSB proof",async()=>{
 await fixture(async({first,one,rootA,rootB})=>{
  await first.claim(one);
  await advance(first,"stopped");
  await assert.rejects(first.releaseAfterVerifiedStop({vmId:ID1,ownerSid:SID,jobJournal:free(rootB),verifyStopped:proof}),/not-releasable/);
  const busy={root:rootA,inspect:async()=>({active:true,status:"running"})};
  await assert.rejects(first.releaseAfterVerifiedStop({vmId:ID1,ownerSid:SID,jobJournal:busy,verifyStopped:proof}),/local-journal-not-released/);
  await assert.rejects(first.releaseAfterVerifiedStop({vmId:ID1,ownerSid:SID,jobJournal:free(rootA),
    verifyStopped:async()=>({vmId:ID1,ownerSid:SID,verifiedAbsent:false})}),/not-independently-confirmed/);
  await assert.rejects(first.releaseAfterVerifiedStop({vmId:ID1,ownerSid:BAD_SID,jobJournal:free(rootA),verifyStopped:proof}),/not-releasable/);
  assert.equal((await first.inspect()).active,true);
 });
});
test("sequential verified release allows next root only after both proofs",async()=>{
 await fixture(async({first,second,one,two,rootA})=>{
  await first.claim(one);
  await advance(first,"stopped");
  const done=await first.releaseAfterVerifiedStop({vmId:ID1,ownerSid:SID,jobJournal:free(rootA),verifyStopped:proof});
  assert.equal(done.released,true);
  assert.deepEqual(await first.inspect(),{active:false,status:"none"});
  assert.equal((await second.claim(two)).jobJournalRoot,two.jobJournalRoot);
 });
});
test("tampered PID and changed global record fingerprint block release",async()=>{
 await fixture(async({first,one,rootA})=>{
  await first.claim(one);
  await advance(first,"stopped");
  const record=await first.read();
  await fs.writeFile(first.recordPath,JSON.stringify({...record,pid:record.pid+10}));
  await assert.rejects(first.releaseAfterVerifiedStop({vmId:ID1,ownerSid:SID,jobJournal:free(rootA),verifyStopped:proof}),/not-releasable/);
  assert.equal((await first.inspect()).active,true);
 });
});
test("symlinked coordination ancestor cannot become the shared host lock",async()=>{
 await fixture(async({base,shared,rootA,one})=>{
  const redirected=path.join(base,"redirected");
  await fs.symlink(shared,redirected,"dir");
  const journal=new HostVmJournal({root:redirected,attestRoot:YES});
  await assert.rejects(journal.claim({...one,jobJournalRoot:rootA}),/unsafe-root-or-ancestor|root-reparse/);
  assert.equal((await journal.inspect()).status,"indeterminate");
 });
});
test("job roots are not allowed to overlap with host root",async()=>{
 await fixture(async({first,one,shared})=>{
  await assert.rejects(first.claim({...one,jobJournalRoot:shared}),/invalid-identity-or-root/);
  await assert.rejects(first.claim({...one,jobJournalRoot:path.join(shared,"jobs")}),/invalid-identity-or-root/);
 });
});
