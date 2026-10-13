/**
 * Windows-only, operator-controlled VM journal recovery.
 * This CLI NEVER launches or stops Windows Sandbox machines.
 * The web server and model-driven agent do not import this entry point.
 */
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { VmOwnershipJournal } from "../src/sandbox/vm-journal.mjs";
import {
  inspectVmRecovery, recoverStoppedVmOwnership, expectedVmRecoveryApproval
} from "../src/sandbox/vm-recovery.mjs";

const argv = process.argv.slice(2);
if (argv.length > 1 || (argv.length && !["--inspect", "--release"].includes(argv[0]))) {
  console.error("Usage: node scripts/manual-vm-recovery.mjs [--inspect|--release]");
  process.exit(2);
}
const mode = argv[0] ?? "--inspect";
const root = path.resolve(process.env.STUDIO_RUNNER_JOBS_ROOT ??
  (process.env.LOCALAPPDATA ?
    path.join(process.env.LOCALAPPDATA, "AIStudio", "SandboxJobs") :
    path.join(process.cwd(), ".pilot-workspace", "offline-runner-packages")));
const journal = new VmOwnershipJournal(root);
const inspected = await inspectVmRecovery({ journal });
console.log(JSON.stringify(inspected, null, 2));

if (mode === "--inspect") process.exit(0);

// Draft #17: legacy per-job recovery cannot safely clear a new host-wide
// owner record, even after two empty VM lists. A trusted dual-record recovery
// transaction, separately attested Windows SID and operator approval are not
// yet wired. Do not let local-only recovery silently appear successful.
console.error("Dual ownership recovery not yet authorized: inspect both " +
  "machine and job records; never remove only the per-job lock.");
process.exit(2);

if (!inspected.eligible) {
  console.error("Recovery is blocked. Investigate the recorded VM and controller state manually.");
  process.exit(2);
}
if (process.env.STUDIO_ALLOW_VM_RECOVERY !== "1") {
  console.error("Manual recovery opt-in required: STUDIO_ALLOW_VM_RECOVERY=1.");
  process.exit(2);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Refusing journal mutation from noninteractive/service/automation sessions.");
  process.exit(2);
}
const phrase = expectedVmRecoveryApproval(inspected);
const reader = createInterface({ input: process.stdin, output: process.stdout });
let supplied = "";
try {
  supplied = await reader.question(
    "The recorded VM must already be stopped. This command cannot stop it.\n" +
    "To release ONLY the matching stale journal, type exactly:\n" + phrase + "\n> "
  );
} finally {
  reader.close();
}
if (supplied !== phrase) {
  console.error("Approval phrase mismatch: journal is unchanged.");
  process.exit(2);
}
try {
  const outcome = await recoverStoppedVmOwnership({
    journal, inspected, approval: supplied, optIn: true,
    interactiveConfirmation: true
  });
  console.log(JSON.stringify(outcome, null, 2));
} catch (error) {
  console.error("Recovery blocked: " + String(error?.message ?? error));
  process.exitCode = 2;
}
