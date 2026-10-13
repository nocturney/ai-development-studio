/**
 * Windows VM manual recovery CLI: READ-ONLY INSPECTION in Studio #17 Draft.
 *
 * NEVER launches/stops WSB. Old per-job recovery must not become a misleading
 * approved action while the machine-wide owner is still occupied. The future
 * two-record recovery must be an independently attested, operator-approved
 * broker transaction. Until then, --release is intentionally unavailable.
 */
import path from "node:path";
import { VmOwnershipJournal } from "../src/sandbox/vm-journal.mjs";
import { createCanonicalWindowsHostJournal } from "../src/sandbox/vm-host-coordinator.mjs";

const args=process.argv.slice(2);
if(args.length>1 || (args.length && !["--inspect","--release"].includes(args[0]))) {
  console.error("Usage: node scripts/manual-vm-recovery.mjs [--inspect|--release]");
  process.exit(2);
}
const mode=args[0]??"--inspect";
const root=path.resolve(process.env.STUDIO_RUNNER_JOBS_ROOT??
  (process.env.LOCALAPPDATA ?
    path.join(process.env.LOCALAPPDATA,"AIStudio","SandboxJobs"):
    path.join(process.cwd(),".pilot-workspace","offline-runner-packages")));

const localJournal=new VmOwnershipJournal(root);
const [local,global]=await Promise.all([
  localJournal.inspect(),
  process.platform==="win32"
    ? createCanonicalWindowsHostJournal().inspect()
    : Promise.resolve({active:true,status:"windows-only",requiresHumanReview:true})
]);
const inspected={
  schema:"studio.vm-dual-recovery-inspection.draft.v1",
  // Indeterminate global status must never be treated as an empty lock.
  active:local.active!==false || global.active!==false,
  eligible:false,
  reason:"dual-owner-recovery-broker-required",
  vmOwnership:local,
  hostOwnership:global,
  dualReleaseAllowed:false,
  requiresHumanReview:true,
  mutationAttempted:false
};
console.log(JSON.stringify(inspected,null,2));
if(mode==="--inspect") process.exit(0);
// Do not mint or accept the OLD per-job typed approval string. Even explicit
// STUDIO_ALLOW_VM_RECOVERY=1 and an interactive TTY cannot authorize release.
console.error("Dual ownership recovery not yet authorized: inspect both " +
  "machine and job records; never remove only the per-job lock.");
process.exit(2);
