/**
 * Draft #17: two-journal transaction for the synthetic VM-controller LAB.
 *
 * This module is a fail-closed *orchestration substrate*; it neither provisions
 * NTFS ACLs nor grants a Windows operator write authority. The HostVmJournal
 * instance must be supplied by a separately reviewed, trusted broker. Both
 * injected attestation and WSB stop proof remain LAB-only until implemented
 * independently of the caller. NEVER wire a model/web input to this object.
 */
import { VmOwnershipJournal } from "./vm-journal.mjs";
import { HostVmJournal } from "./vm-host-coordinator.mjs";

function denied(why) { throw Error("dual-vm:" + why); }
function recordsMatch(local, global, root) {
  return local && global &&
    local.vmId === global.vmId && local.jobId === global.jobId &&
    local.manifestHash === global.manifestHash &&
    local.ownerSid === global.ownerSid &&
    local.pid === global.pid && global.jobJournalRoot === root &&
    local.phase === global.phase;
}

/**
 * Claim order is always host FIRST, then per-job. A failure after either
 * durable write retains the host reservation. No rollback without independent
 * VM stop proof + operator review: a partial claim is safer than duplicate VM.
 */
export class DualVmOwnershipJournal extends VmOwnershipJournal {
  constructor({jobRoot,hostJournal,verifyStopped} = {}) {
    super(jobRoot);
    if (!(hostJournal instanceof HostVmJournal)) denied("host-journal-required");
    if (typeof verifyStopped !== "function") denied("independent-stop-proof-required");
    this.hostJournal = hostJournal;
    this.verifyStopped = verifyStopped;
  }

  async inspect() {
    let host,local,hostRecord,localRecord;
    try {
      host = await this.hostJournal.inspect();
      local = await super.inspect();
      if (host.status === "indeterminate" || local.status === "indeterminate")
        return {active:true,status:"indeterminate",requiresManualReview:true};
      if (!host.active && !local.active)
        return {active:false,status:"none"};
      if (!host.active || !local.active)
        return {active:true,status:"partial-dual-owner",requiresManualReview:true};
      hostRecord = await this.hostJournal.read();
      localRecord = await super.read();
      if (!recordsMatch(localRecord,hostRecord,this.root))
        return {active:true,status:"conflicting-dual-owner",requiresManualReview:true};
      return {active:true,status:localRecord.phase,vmId:localRecord.vmId,
        jobId:localRecord.jobId,requiresManualReview:true};
    } catch {
      return {active:true,status:"indeterminate",requiresManualReview:true};
    }
  }

  async claim({vmId,jobId,manifestHash,ownerSid} = {}) {
    // Reject incomplete identities *before* either journal changes.
    if (typeof ownerSid !== "string" || !/^S-1-\d+(?:-\d+){2,15}$/i.test(ownerSid))
      denied("owner-sid-required");
    // An atomic mkdir on the single trusted machine root arbitrates otherwise
    // unrelated job roots. A missing ACL attestation is always a hard failure.
    await this.hostJournal.claim({vmId,jobId,manifestHash,
      ownerSid,jobJournalRoot:this.root});
    try {
      await super.claim({vmId,jobId,manifestHash,ownerSid});
    } catch (cause) {
      throw Error("dual-vm:local-claim-failed-global-held-for-manual-review",{cause});
    }
    const local = await super.read(),global = await this.hostJournal.read();
    if (!recordsMatch(local,global,this.root)) denied("claim-mismatch-global-held");
    return local;
  }

  async transition(vmId,phase) {
    const local = await super.read(),global = await this.hostJournal.read();
    if (!recordsMatch(local,global,this.root) || local.pid !== process.pid)
      denied("transition-record-mismatch");
    // Fail closed on crash halfway: if global changed and local did not,
    // neither can be automatically cleared or advanced as a valid pair.
    await this.hostJournal.transition(vmId,phase,local.ownerSid);
    await super.transition(vmId,phase);
    const afterLocal=await super.read(),afterGlobal=await this.hostJournal.read();
    if (!recordsMatch(afterLocal,afterGlobal,this.root))
      denied("transition-partial-global-held");
    return afterLocal;
  }

  /**
   * NEVER inherit VmOwnershipJournal's local-only manual recovery unlink.
   * The dual owner is a separate machine-wide authority: clearing merely the
   * per-job record could leave a live VM or break the consent fingerprint.
   * Only a separately reviewed trusted broker may ever release BOTH records.
   */
  async releaseAfterManualRecovery() {
    denied("dual-recovery-broker-not-admitted");
  }

  async releaseStopped(vmId) {
    const local=await super.read(),global=await this.hostJournal.read();
    if (!recordsMatch(local,global,this.root) || local.vmId !== vmId ||
        local.pid !== process.pid || local.phase !== "stopped")
      denied("release-pair-not-proven");
    // First distinct WSB absence check before deleting per-job owner.
    // A second fresh check occurs inside HostVmJournal *after* local release.
    const proof=await this.verifyStopped({vmId,ownerSid:local.ownerSid});
    if (proof?.vmId !== vmId || proof?.ownerSid !== local.ownerSid ||
        proof?.verifiedAbsent !== true) denied("independent-stop-proof-failed");
    await super.releaseStopped(vmId);
    // If second proof or release fails, host lock is retained. It must not be
    // automatically retried/reconciled by the regular runner.
    // HostVmJournal must inspect only the per-job journal at this point:
    // Dual.inspect() intentionally reports a held global lock as active.
    const localOnly={root:this.root,inspect:()=>super.inspect()};
    return this.hostJournal.releaseAfterVerifiedStop({
      vmId,ownerSid:local.ownerSid,jobJournal:localOnly,
      verifyStopped:this.verifyStopped
    });
  }
}
