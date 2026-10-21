import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {HostVmJournal} from "../src/sandbox/vm-host-coordinator.mjs";
import {DualVmOwnershipJournal} from "../src/sandbox/vm-dual-journal.mjs";
import {runWindowsVmJob,expectedVmApproval} from "../src/sandbox/vm-controller.mjs";

const VM1="9b9b7c43-0a91-472a-b4f7-d2e5d1f341c9";
const VM2="9beec84e-a371-4bc2-8e87-9ec421f3e1b3";
const JOB1="7e9421ec-7f93-421e-96e2-c9e3e70ff098";
const JOB2="5fabd951-d495-4aac-a569-d18c16f46c32";
const HASH="d".repeat(64);
const SID="S-1-5-21-100-200-300-1001";
const EMPTY='{"WindowsSandboxEnvironments":[]}';
const BUSY=JSON.stringify({WindowsSandboxEnvironments:[{Id:VM1}]});

async function fixture(run){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"studio-crossroot-controller-"));
  const machine=path.join(root,"machine");
  await fs.mkdir(machine);
  const makeJournal=async(name)=>{
    const jobRoot=path.join(root,name,"jobs");
    await fs.mkdir(path.dirname(jobRoot),{recursive:true});
    return new DualVmOwnershipJournal({
      jobRoot,
      hostJournal:new HostVmJournal({root:machine,attestRoot:async()=>({verified:true})}),
      verifyStopped:async({vmId,ownerSid})=>({vmId,ownerSid,verifiedAbsent:true})
    });
  };
  const staged=async(id,rootName)=>{
    const pathRoot=path.join(root,rootName);
    const outputDir=path.join(pathRoot,"output");
    await fs.mkdir(outputDir,{recursive:true});
    const configPath=path.join(pathRoot,"job.wsb");
    await fs.writeFile(configPath,"<Configuration><Networking>Disable</Networking></Configuration>");
    return {id,manifestHash:HASH,runtimeSha256:"e".repeat(64),
      configPath,outputDir,manifest:{id,manifestHash:HASH,timeoutSeconds:5}};
  };
  const args=(job,journal,vmId,vmCommand)=>({
    staged:job,journal,vmId,vmCommand,
    approval:expectedVmApproval(job),
    executionOptIn:true,interactiveConfirmation:true,guestBootWaitMs:0,
    startupGraceMs:1000,
    readinessProbe:async()=>({featureReady:true,platform:"win32",
      session:"interactive",cliPresent:true,userSid:SID,
      executable:"C:\\Windows\\System32\\wsb.exe"}),
    preflight:async()=>({verified:true,executionEnabled:false,
      manifestHash:HASH,id:job.id}),
    reportReader:async()=>JSON.stringify({
      schema:"studio.runner.v1",id:job.id,manifestHash:HASH,
      status:"passed",exitCode:0,elapsedMs:1,stdout:"mock-passed",stderr:""})
  });
  try {
    await run({root,machine,makeJournal,staged,args});
  } finally {
    await fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});
  }
}
async function defer() {
 let resolve;
 const promise=new Promise(r=>resolve=r);
 return {promise,resolve};
}

test("actual VM controller admits one simulated WSB start across TWO different job roots",async()=>{
 await fixture(async({makeJournal,staged,args})=>{
   const j1=await makeJournal("root-a");
   const j2=await makeJournal("root-b");
   const s1=await staged(JOB1,"root-a");
   const s2=await staged(JOB2,"root-b");
   const started=await defer(),resume=await defer();
   const actions=[];
   const vm=async(_,argv)=>{
     actions.push({vm:argv[2],kind:argv[0]});
     if(argv[0]==="start"&&argv[2]===VM1){
       started.resolve();
       await resume.promise;
     }
     return {stdout:argv[0]==="exec"?'{"ExitCode":0}':
       argv[0]==="list"?EMPTY:""};
   };
   const first=runWindowsVmJob(args(s1,j1,VM1,vm));
   await started.promise;
   assert.equal((await j1.inspect()).status,"launch-requested");
   await assert.rejects(runWindowsVmJob(args(s2,j2,VM2,vm)),
     /host-vm:occupied-requires-manual-review/);
   assert.equal(actions.filter(a=>a.kind==="start").length,1);
   resume.resolve();
   const done=await first;
   assert.equal(done.sandboxStopped,true);
   assert.equal((await j1.inspect()).active,false);
   assert.equal((await j2.inspect()).active,false);
   const next=await runWindowsVmJob(args(s2,j2,VM2,vm));
   assert.equal(next.sandboxStopped,true);
   assert.deepEqual(actions.filter(a=>a.kind==="start").map(a=>a.vm),[VM1,VM2]);
 });
});
test("stop that returns without confirmed VM disappearance keeps both locks and denies other root",async()=>{
 await fixture(async({makeJournal,staged,args})=>{
   const j1=await makeJournal("root-a");
   const j2=await makeJournal("root-b");
   const s1=await staged(JOB1,"root-a");
   const s2=await staged(JOB2,"root-b");
   const calls=[];
   const vm=async(_,argv)=>{
     calls.push(argv[0]);
     return {stdout:argv[0]==="exec"?'{"ExitCode":0}':
       argv[0]==="list"?BUSY:""};
   };
   await assert.rejects(runWindowsVmJob({
     ...args(s1,j1,VM1,vm),wait:async()=>{}
   }),/vm-stop-not-confirmed/);
   assert.equal((await j1.inspect()).status,"stop-unverified");
   assert.equal((await j2.inspect()).status,"partial-dual-owner");
   const before=calls.filter(x=>x==="start").length;
   await assert.rejects(runWindowsVmJob(args(s2,j2,VM2,vm)),
     /host-vm:occupied-requires-manual-review/);
   assert.equal(calls.filter(x=>x==="start").length,before);
 });
});
test("unattested host-global ACL blocks VM start even if all other approvals and local preflight pass",async()=>{
 await fixture(async({root,machine,staged,args})=>{
   const jobRoot=path.join(root,"root-a","jobs");
   const journal=new DualVmOwnershipJournal({
     jobRoot,hostJournal:new HostVmJournal({
       root:machine,attestRoot:async()=>({verified:false})
     }),verifyStopped:async({vmId,ownerSid})=>({vmId,ownerSid,verifiedAbsent:true})
   });
   const job=await staged(JOB1,"root-a");
   const calls=[];
   await assert.rejects(runWindowsVmJob(args(job,journal,VM1,async()=>{
     calls.push("VM_COMMAND_CALLED");throw Error("unreachable");
   })),/host-acl-and-sid-not-attested/);
   assert.deepEqual(calls,[]);
   assert.equal((await fs.readdir(machine)).length,0);
 });
});
