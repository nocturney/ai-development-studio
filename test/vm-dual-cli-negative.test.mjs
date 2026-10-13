import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const runner=fileURLToPath(new URL("../scripts/manual-vm-runner.mjs",import.meta.url));
const recovery=fileURLToPath(new URL("../scripts/manual-vm-recovery.mjs",import.meta.url));

async function fixture(fn) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"studio-manual-dual-negative-"));
 try {await fn(root);}
 finally {await fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
}
function invoke(file,mode,root) {
 return spawnSync(process.execPath,[file,mode],{
  cwd:root,encoding:"utf8",timeout:12000,windowsHide:true,
  env:{...process.env,STUDIO_RUNNER_JOBS_ROOT:path.join(root,"jobs"),
   STUDIO_ALLOW_VM_EXECUTION:"1",STUDIO_ALLOW_VM_RECOVERY:"1"}
 });
}
test("manual --run-demo never stages or launches until trusted host broker is available",async()=>{
 await fixture(async root=>{
  const r=invoke(runner,"--run-demo",root);
  assert.equal(r.status,2,r.stderr);
  assert.match(r.stderr,/independent host-wide owner broker/);
  assert.ok(!r.stdout.includes("VM EVENT"));
  assert.deepEqual(await fs.readdir(root),[]);
 });
});
test("manual local-only --release fails closed even with opt-in env",async()=>{
 await fixture(async root=>{
  const r=invoke(recovery,"--release",root);
  assert.equal(r.status,2,r.stderr);
  assert.match(r.stderr,/Dual ownership recovery not yet authorized/);
  assert.deepEqual(await fs.readdir(root),[]);
 });
});
test("manual --status reports global coordination separately but never enables execution",async()=>{
 await fixture(async root=>{
  const r=invoke(runner,"--status",root);
  assert.equal(r.status,0,r.stderr);
  const d=JSON.parse(r.stdout);
  assert.equal(d.executionEnabled,false);
  assert.equal(d.trustedHostBrokerReady,false);
  assert.ok(d.hostOwnership && typeof d.hostOwnership.status==="string");
  assert.deepEqual(await fs.readdir(root),[]);
 });
});

test("manual --inspect never advertises false dual-owner release eligibility",async()=>{
 await fixture(async root=>{
  const r=invoke(recovery,"--inspect",root);
  assert.equal(r.status,0,r.stderr);
  const inspection=JSON.parse(r.stdout);
  assert.equal(inspection.eligible,false);
  assert.equal(inspection.dualReleaseAllowed,false);
  assert.equal(inspection.mutationAttempted,false);
  assert.equal(inspection.reason,"dual-owner-recovery-broker-required");
  assert.ok(inspection.hostOwnership&&typeof inspection.hostOwnership.status==="string");
  assert.ok(inspection.vmOwnership&&typeof inspection.vmOwnership.status==="string");
  assert.deepEqual(await fs.readdir(root),[]);
 });
});
