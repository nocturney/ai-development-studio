import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {HostVmJournal} from "../src/sandbox/vm-host-coordinator.mjs";

const WORKER=fileURLToPath(new URL("./fixtures/vm-host-child-worker.mjs",import.meta.url));
const ID1="b9a45738-70d9-448e-b20e-a50c828c551f";
const ID2="e2f62dcf-27c8-433b-9dc1-a60e5c357050";
const JOB1="1544cb72-81f0-43ba-9531-44446dcc7a8a";
const JOB2="7d30bbf7-b79c-43d1-ab51-7ef3e2b6ed45";
const SID="S-1-5-21-101-202-303-1001";
const HASH="c".repeat(64);
function start(mode,root,job,vm,jobId,hold=false){
 return spawn(process.execPath,[WORKER,mode,root,job,vm,jobId,HASH,SID],{
  stdio:["pipe","pipe","pipe"],
  env:{...process.env,HOST_TEST_HOLD:hold?"1":"0"},
  windowsHide:true
 });
}
async function outputLine(proc,expected){
 let stdout="",stderr="";
 proc.stderr.on("data",chunk=>stderr+=chunk.toString());
 return await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(Error("child-timeout stdout="+stdout+" stderr="+stderr)),8000);
  function finish(line){clearTimeout(timeout);proc.stdout.off("data",onData);proc.off("error",onError);resolve(line);}
  function onError(error){clearTimeout(timeout);reject(error);}
  function onData(chunk){
   stdout+=chunk.toString();
   if(stdout.includes("\n"))finish(stdout.split("\n")[0]);
  }
  proc.stdout.on("data",onData);
  proc.once("error",onError);
  proc.once("close",code=>{
   if(!stdout.includes("\n"))onError(Error("child-exited-"+code+" stdout="+stdout+" stderr="+stderr));
  });
 });
}
async function rejected(proc){
 const line=await outputLine(proc);
 assert.match(line,/^DENIED:host-vm:/);
 const [code]=await once(proc,"close");
 assert.equal(code,43);
 return line;
}
test("independent processes from separate job roots cannot claim, impersonate or re-claim a crashed VM controller",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"studio-crosspid-lock-"));
 const hostRoot=path.join(root,"host"),jobsA=path.join(root,"jobs-a"),jobsB=path.join(root,"jobs-b");
 await Promise.all([fs.mkdir(hostRoot),fs.mkdir(jobsA),fs.mkdir(jobsB)]);
 const journal=new HostVmJournal({root:hostRoot,attestRoot:async()=>({verified:true})});
 let first;
 try{
  first=start("claim",hostRoot,jobsA,ID1,JOB1,true);
  t.after(()=>{if(first && first.exitCode===null)first.kill("SIGKILL");});
  const firstLine=await outputLine(first);
  assert.equal(firstLine,"CLAIMED:"+first.pid);
  const persistent=await journal.read();
  assert.equal(persistent.pid,first.pid);
  assert.equal(persistent.jobJournalRoot,jobsA);
  assert.equal(persistent.phase,"reserved");

  const second=start("claim",hostRoot,jobsB,ID2,JOB2);
  assert.match(await rejected(second),/occupied-requires-manual-review/);

  const impersonator=start("transition",hostRoot,jobsA,ID1,JOB1);
  assert.match(await rejected(impersonator),/invalid-transition/);
  assert.equal((await journal.read()).phase,"reserved");

  first.kill("SIGKILL");
  await once(first,"close");
  const afterCrash=await journal.inspect();
  assert.equal(afterCrash.active,true);
  assert.equal(afterCrash.vmId,ID1);
  assert.equal(afterCrash.requiresHumanReview,true);
  assert.match(await rejected(start("claim",hostRoot,jobsB,ID2,JOB2)),/occupied-requires-manual-review/);
 }finally{
  if(first && first.exitCode===null)first.kill("SIGKILL");
  await fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});
 }
});
