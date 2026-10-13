/**
 * Explicit-only Windows Sandbox orphan journal inspection and recovery.
 *
 * NEVER starts or stops VMs, never scans other roots, never clears malformed
 * locks, never accepts model inputs or executes from the Studio HTTP server.
 * Recovery requires a logged-on Windows user, exact typed approval and two
 * independent empty WSB lists while the original owner PID is confirmed dead.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { probeWindowsVm, parseSandboxListResponse } from "./vm-controller.mjs";
import { VmOwnershipJournal, vmOwnershipFingerprint } from "./vm-journal.mjs";
import { DualVmOwnershipJournal } from "./vm-dual-journal.mjs";

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const SID = /^S-1-\d+(?:-\d+){2,15}$/i;
export const VM_RECOVERY_SCHEMA = "studio.vm-recovery.v1";
export const VM_RECOVERY_PREFIX = "RELEASE VERIFIED STOPPED VM ";

async function defaultListVmIds(ready) {
  const { stdout } = await execFileAsync(ready.executable, ["list", "--raw"], {
    timeout: 15000, windowsHide: true, maxBuffer: 24000
  });
  return parseSandboxListResponse(stdout);
}

async function defaultOwnerPidAlive(pid) {
  try {
    process.kill(pid, 0); // Signal 0 checks existence without termination.
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return null; // EPERM, unsupported or ambiguous always fail closed.
  }
}

function validList(value) {
  return value instanceof Set && value.size <= 256 &&
    [...value].every(id => typeof id === "string" && UUID.test(id));
}

function publicBase(record) {
  return {
    schema: VM_RECOVERY_SCHEMA, active: true, eligible: false,
    vmId: record.vmId, jobId: record.jobId, phase: record.phase,
    recordToken: vmOwnershipFingerprint(record),
    originalOwnerPid: record.pid,
    requiresExplicitOperatorApproval: true
  };
}

export function expectedVmRecoveryApproval(report) {
  if (!report?.eligible || !UUID.test(report.vmId) ||
      !UUID.test(report.jobId) || !HASH.test(report.recordToken)) {
    throw Error("vm-recovery-not-approved-for-inspection");
  }
  return VM_RECOVERY_PREFIX + report.vmId + " " + report.jobId + " " +
    report.recordToken.slice(0, 12);
}

export async function inspectVmRecovery({
  journal, readinessProbe = probeWindowsVm,
  listVmIds = defaultListVmIds, ownerPidAlive = defaultOwnerPidAlive
}) {
  if (!(journal instanceof VmOwnershipJournal)) throw Error("vm-recovery-journal-required");
  const initial = await journal.inspect();
  if (journal instanceof DualVmOwnershipJournal) {
    // An older per-job-only inspector may otherwise pronounce an orphan
    // eligible, while machine-global owner still holds an active reservation.
    // Until a separately attested TWO-RECORD recovery exists, do not even
    // mint an operator approval phrase from this entry point.
    return {schema:VM_RECOVERY_SCHEMA,active:initial.active !== false,
      eligible:false,reason:"dual-owner-recovery-broker-required",
      requiresManualReview:true};
  }
  if (!initial.active) {
    return { schema: VM_RECOVERY_SCHEMA, active: false, eligible: false,
      reason: "no-active-ownership" };
  }
  if (initial.status === "indeterminate") {
    return { schema: VM_RECOVERY_SCHEMA, active: true, eligible: false,
      reason: "invalid-owner-record" };
  }

  let record;
  try { record = await journal.read(); } catch {
    return { schema: VM_RECOVERY_SCHEMA, active: true, eligible: false,
      reason: "invalid-owner-record" };
  }
  if (!record || !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 || record.pid > 2147483647) {
    return { schema: VM_RECOVERY_SCHEMA, active: true, eligible: false,
      reason: "unverifiable-owner-pid" };
  }
  const base = publicBase(record);
  let ready;
  try { ready = await readinessProbe(); } catch {
    return { ...base, reason: "vm-host-unavailable" };
  }
  if (ready?.platform !== "win32" || ready.session !== "interactive" ||
      ready.featureReady !== true || ready.cliPresent !== true ||
      typeof ready.executable !== "string" || !ready.executable) {
    return { ...base, reason: "vm-host-unavailable" };
  }
  if (!SID.test(record.ownerSid)) {
    // Legacy journals did not bind to a Windows user SID. A different user
    // could see an empty per-user WSB list while the original user's VM lives.
    return { ...base, reason: "legacy-owner-identity-unbound" };
  }
  if (!SID.test(ready.userSid) || ready.userSid !== record.ownerSid) {
    return { ...base, reason: "different-windows-identity" };
  }
  let alive;
  try { alive = await ownerPidAlive(record.pid); }
  catch { alive = null; }
  if (alive !== false) {
    return { ...base, reason: alive === true
      ? "original-controller-process-still-alive" : "controller-process-status-unknown" };
  }
  let sessions;
  try { sessions = await listVmIds(ready); } catch {
    return { ...base, reason: "vm-list-unavailable" };
  }
  if (!validList(sessions)) return { ...base, reason: "invalid-vm-list" };
  if (sessions.size !== 0) {
    return { ...base, reason: "sandbox-sessions-still-present",
      visibleVmCount: sessions.size };
  }
  return { ...base, eligible: true, reason: "requires-typed-operator-approval",
    visibleVmCount: 0 };
}

/**
 * Explicit action only. The first inspection is performed before prompting the
 * operator. This function rechecks everything after the operator has confirmed,
 * including a second real WSB list and a fresh owner fingerprint.
 */
export async function recoverStoppedVmOwnership({
  journal, approval, inspected, optIn = false, interactiveConfirmation = false,
  readinessProbe = probeWindowsVm, listVmIds = defaultListVmIds,
  ownerPidAlive = defaultOwnerPidAlive, pause = ms =>
    new Promise(resolve => setTimeout(resolve, ms))
}) {
  if (!(journal instanceof VmOwnershipJournal)) throw Error("vm-recovery-journal-required");
  if (journal instanceof DualVmOwnershipJournal)
    throw Error("dual-owner-recovery-broker-required");
  if (!optIn || !interactiveConfirmation || !inspected?.eligible ||
      approval !== expectedVmRecoveryApproval(inspected)) {
    throw Error("explicit-vm-recovery-approval-required");
  }
  const probes = { journal, readinessProbe, listVmIds, ownerPidAlive };
  const first = await inspectVmRecovery(probes);
  if (!first.eligible || first.recordToken !== inspected.recordToken ||
      first.vmId !== inspected.vmId || first.jobId !== inspected.jobId) {
    throw Error("vm-recovery-first-check-failed");
  }
  await pause(1200);
  const second = await inspectVmRecovery(probes);
  if (!second.eligible || second.recordToken !== inspected.recordToken ||
      second.vmId !== inspected.vmId || second.jobId !== inspected.jobId) {
    throw Error("vm-recovery-second-check-failed");
  }
  const finalRecord = await journal.read();
  if (!finalRecord || vmOwnershipFingerprint(finalRecord) !== inspected.recordToken) {
    throw Error("vm-owner-record-changed-during-recovery");
  }
  const result = await journal.releaseAfterManualRecovery({
    vmId: inspected.vmId, expectedFingerprint: inspected.recordToken
  });
  return {
    schema: VM_RECOVERY_SCHEMA, released: result.released,
    vmId: inspected.vmId, jobId: inspected.jobId,
    previousPhase: inspected.phase,
    confirmedEmptyVmLists: 2,
    originalControllerInactive: true,
    guestResultTrusted: false,
    codeChangesApproved: false
  };
}
