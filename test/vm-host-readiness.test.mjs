import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {
  evaluateNativeHostFacts, parseNativeHostFacts, checkVmHostReadiness,
  attestWindowsVmHostRoot
} from "../src/sandbox/vm-host-readiness.mjs";
import {WINDOWS_VM_HOST_ROOT} from "../src/sandbox/vm-host-coordinator.mjs";

const SYSTEM="S-1-5-18", ADMINS="S-1-5-32-544", USERS="S-1-5-32-545";
const OPERATOR="S-1-5-21-111-222-333-1001", FULL=0x1f01ff, READ_EXEC=0x1200a9;
const CLI=fileURLToPath(new URL("../scripts/manual-vm-host-readiness.mjs",import.meta.url));
const MODULE=fileURLToPath(new URL("../src/sandbox/vm-host-readiness.mjs",import.meta.url));

// Fixture is a Windows-shaped probe result, always supplied as data (never a trusted verdict).
function ready(patch={}){
 return {
  platform:"win32",
  user:{name:"CHRIS\\Chris",sid:OPERATOR},
  session:2, elevated:true, rootPresent:true, reparsePoints:[],
  owner:SYSTEM, protected:true,
  rules:[
   {sid:SYSTEM,type:"Allow",rights:FULL,inherited:false},
   {sid:ADMINS,type:"Allow",rights:FULL,inherited:false},
   {sid:OPERATOR,type:"Allow",rights:READ_EXEC,inherited:false}
  ],
  ...patch
 };
}

test("elevated interactive CHRIS\\Chris with protected SYSTEM-owned root is ready without execution", ()=>{
 const verdict=evaluateNativeHostFacts(ready());
 assert.equal(verdict.ready,true);
 assert.equal(verdict.reason,"native-host-root-ready");
 assert.equal(verdict.operatorSid,OPERATOR);
 assert.equal(verdict.executionEnabled,false);
 assert.equal(verdict.mutationAttempted,false);
 assert.equal(verdict.sandboxStartAttempted,false);
});

test("each unsafe native fact is rejected with a specific reason", ()=>{
 const cases=[
  [{platform:"darwin"},"windows-only"],
  [{user:{name:"CHRIS\\Other",sid:OPERATOR}},"wrong-operator-account"],
  [{user:{name:"NT AUTHORITY\\SYSTEM",sid:SYSTEM}},"wrong-operator-account"],
  [{user:{name:"CHRIS\\Chris",sid:SYSTEM}},"service-identity"],
  [{user:{name:"CHRIS\\Chris",sid:"S-1-5-80-1-2-3-4-5"}},"service-identity"],
  [{session:0},"session-zero"],
  [{session:-1},"non-interactive-session"],
  [{elevated:false},"non-elevated-token"],
  [{rootPresent:false,owner:undefined,protected:undefined,rules:undefined},"root-absent"],
  [{reparsePoints:["C:\\ProgramData\\AIStudio"]},"root-reparse"],
  [{owner:ADMINS},"root-owner-not-system"],
  [{protected:false},"root-acl-unprotected"],
  [{rules:[{sid:SYSTEM,type:"Allow",rights:FULL,inherited:true},{sid:ADMINS,type:"Allow",rights:FULL,inherited:false}]},"root-acl-unprotected"],
  [{rules:[...ready().rules,{sid:USERS,type:"Deny",rights:0x2,inherited:false}]},"deny-ace-present"],
  [{rules:[...ready().rules,{sid:USERS,type:"Allow",rights:0x2,inherited:false}]},"mutable-root-acl"],
  [{rules:[...ready().rules,{sid:OPERATOR,type:"Allow",rights:FULL,inherited:false}]},"mutable-root-acl"],
  [{rules:[{sid:SYSTEM,type:"Allow",rights:FULL,inherited:false},{sid:OPERATOR,type:"Allow",rights:READ_EXEC,inherited:false}]},"root-acl-missing-full-control"]
 ];
 for (const [patch,reason] of cases) {
  const verdict=evaluateNativeHostFacts(ready(patch));
  assert.equal(verdict.ready,false,reason);
  assert.equal(verdict.reason,reason);
 }
});

test("probe output is parsed strictly and malformed or oversized data is refused", ()=>{
 const good=JSON.stringify({user:{name:"CHRIS\\Chris",sid:OPERATOR},session:2,elevated:true,
  rootPresent:false,reparsePoints:[]});
 assert.equal(parseNativeHostFacts(good).rootPresent,false);
 for (const bad of [
  "not json",
  JSON.stringify([]),
  JSON.stringify({user:{name:"CHRIS\\Chris",sid:"bogus"},session:2,elevated:true,rootPresent:false,reparsePoints:[]}),
  JSON.stringify({user:{name:"CHRIS\\Chris",sid:OPERATOR},session:"2",elevated:true,rootPresent:false,reparsePoints:[]}),
  JSON.stringify({user:{name:"CHRIS\\Chris",sid:OPERATOR},session:2,elevated:true,rootPresent:true,reparsePoints:[],
    owner:SYSTEM,protected:true,rules:[{sid:SYSTEM,type:"Allow",rights:-1,inherited:false}]}),
  JSON.stringify({user:{name:"CHRIS\\Chris",sid:OPERATOR},session:2,elevated:true,rootPresent:true,reparsePoints:[],
    owner:SYSTEM,protected:true,rules:Array.from({length:65},()=>({sid:SYSTEM,type:"Allow",rights:FULL,inherited:false}))}),
  "x".repeat(20000)
 ]) {
  assert.throws(()=>parseNativeHostFacts(bad),/native-host-facts-invalid/);
 }
});

test("non-Windows hosts never run the native probe and report windows-only", async()=>{
 if (process.platform==="win32") return;
 const verdict=await checkVmHostReadiness();
 assert.equal(verdict.ready,false);
 assert.equal(verdict.reason,"windows-only");
 assert.equal(verdict.operatorSid,null);
});

test("attestor refuses non-canonical roots and any unverified host, never trusting caller SIDs", async()=>{
 assert.deepEqual(await attestWindowsVmHostRoot({root:"C:\\Temp\\VmOwner",ownerSid:OPERATOR}),
  {verified:false,reason:"root-not-canonical"});
 const forged=await attestWindowsVmHostRoot({root:path.win32.normalize(WINDOWS_VM_HOST_ROOT),ownerSid:OPERATOR});
 assert.equal(forged.verified,false);
});

test("CLI is read-only, refuses extra arguments and reports not-ready off Windows", ()=>{
 const denied=spawnSync(process.execPath,[CLI,"--run"],{encoding:"utf8"});
 assert.equal(denied.status,2);
 assert.match(denied.stderr,/Usage: node scripts\/manual-vm-host-readiness\.mjs/);

 const run=spawnSync(process.execPath,[CLI],{encoding:"utf8"});
 const verdict=JSON.parse(run.stdout);
 assert.equal(verdict.ready,false);
 assert.equal(verdict.mutationAttempted,false);
 assert.equal(verdict.executionEnabled,false);
 if (process.platform!=="win32") assert.equal(run.status,2);
});

test("readiness module contains no write, ACL-change, service or Sandbox-start call", async()=>{
 const source=await fs.readFile(MODULE,"utf8");
 const script=await fs.readFile(CLI,"utf8");
 for (const text of [source,script]) {
  assert.doesNotMatch(text,/Set-Acl|Set-Item|New-Item|Remove-Item|Set-Content|Out-File|Start-Process|Stop-Process|Start-Service|icacls|\bwsb\b|\bunlink\b|writeFile|mkdir/i);
 }
});

test("manual VM runner remains fail-closed and does not consume the readiness attestor", async()=>{
 const runner=await fs.readFile(new URL("../scripts/manual-vm-runner.mjs",import.meta.url),"utf8");
 assert.match(runner,/VM launch refused/);
 assert.doesNotMatch(runner,/vm-host-readiness|attestWindowsVmHostRoot/);
});
