/**
 * Synthetic-only child process: tests the atomic host claim on real independent
 * PIDs. Never launches Sandbox or uses an OS trust attestor.
 */
import {HostVmJournal} from "../../src/sandbox/vm-host-coordinator.mjs";
const [action, root, jobs, vmId, jobId, hash, ownerSid]=process.argv.slice(2);
const host=new HostVmJournal({root,attestRoot:async()=>({verified:true})});
try{
 if(action==="claim"){
  await host.claim({vmId,jobId,manifestHash:hash,ownerSid,jobJournalRoot:jobs});
  process.stdout.write("CLAIMED:"+process.pid+"\n");
  if(process.env.HOST_TEST_HOLD==="1") process.stdin.resume();
 }else if(action==="transition"){
  await host.transition(vmId,"launch-requested",ownerSid);
  process.stdout.write("TRANSITIONED\n");
 }else{throw Error("invalid-synthetic-command");}
}catch(error){
 process.stdout.write("DENIED:"+String(error.message)+"\n");
 process.exitCode=43;
}
