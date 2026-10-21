/**
 * Read-only native host-root readiness check for a future authorized interactive
 * dry-run. NEVER writes, changes ACLs, starts Windows Sandbox or launches a VM.
 * Exit 0 only when the fixed native probe proves an elevated interactive
 * operator with the expected protected root ACL. Exit 2 otherwise.
 */
import { checkVmHostReadiness } from "../src/sandbox/vm-host-readiness.mjs";

const args = process.argv.slice(2);
if (args.length) {
  console.error("Usage: node scripts/manual-vm-host-readiness.mjs");
  process.exit(2);
}
const verdict = await checkVmHostReadiness();
console.log(JSON.stringify(verdict, null, 2));
process.exitCode = verdict.ready ? 0 : 2;
