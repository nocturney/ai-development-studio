/**
 * Draft P0 host-wide Windows Sandbox ownership substrate (NON-OPERATIVE).
 *
 * A machine-owned root must be provisioned/ACL-attested by a human first.
 * This file DOES NOT start/stop WSB or authorize recovery, and is NOT wired to
 * the production manual CLI. Synthetic callers can inject an attestor/proof;
 * that is NOT a production security boundary. Never run model-authored code.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SID = /^S-1-\d+(?:-\d+){2,15}$/i;
const PHASES = new Set(["reserved","launch-requested","running","stopping","stopped","stop-unverified"]);
// One originating PID is permitted to advance the durable owner, but that
// PID may have multiple HostVmJournal objects. Serialize those transitions
// across instances to prevent leftover .owner-*.tmp files on overlapping calls.
// This is LAB-level concurrency protection, NOT a native Windows lock broker.
const IN_FLIGHT_HOST_TRANSITIONS = new Set();
const hostTransitionKey = root => process.platform === "win32" ? root.toLowerCase() : root;
const TRANSITIONS = Object.freeze({
  reserved: ["launch-requested","stopped"],
  "launch-requested": ["running","stopping","stopped","stop-unverified"],
  running: ["stopping","stop-unverified"],
  stopping: ["stopped","stop-unverified"],
  stopped: [],
  "stop-unverified": []
});
export const VM_HOST_SCHEMA = "studio.vm-host-ownership.draft.v1";
/** Canonical host root is independent of STUDIO_RUNNER_JOBS_ROOT or cwd. */
export const WINDOWS_VM_HOST_ROOT = "C:\\ProgramData\\AIStudio\\VmOwner";

function reject(message) { throw new Error("host-vm:" + message); }
function fingerprint(record) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}
function safeAbsolute(root) {
  return typeof root === "string" && path.isAbsolute(root) &&
    path.resolve(root) !== path.parse(root).root &&
    root.length < 230 && !root.includes("\0") && path.normalize(root) === path.resolve(root);
}
function validOwner(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      Object.keys(record).sort().join(",") !==
        ["schema","vmId","jobId","manifestHash","ownerSid","jobJournalRoot","pid",
         "phase","createdAt","updatedAt"].sort().join(",") ||
      record.schema !== VM_HOST_SCHEMA || !UUID.test(record.vmId) ||
      !UUID.test(record.jobId) || !SHA256.test(record.manifestHash) ||
      !SID.test(record.ownerSid) || !safeAbsolute(record.jobJournalRoot) ||
      !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
      !PHASES.has(record.phase) || typeof record.createdAt !== "string" ||
      typeof record.updatedAt !== "string") reject("invalid-record");
  return record;
}
async function assertExistingNoLinks(root) {
  if (!safeAbsolute(root)) reject("invalid-root");
  let current = root;
  while (true) {
    let stat;
    try { stat = await fs.lstat(current); }
    catch { reject("coordination-root-unavailable"); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject("unsafe-root-or-ancestor");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const canonical = path.resolve(await fs.realpath(root));
  if (process.platform === "win32") {
    // Native Win32 realpath may recase C:\\Windows\\TEMP to C:\\Windows\\Temp.
    // Requiring byte-identical case incorrectly blocks legitimate NTFS roots.
    // Retain two independent safeguards: exact case-folded canonical path
    // AND same native file identity. A same-name/different-inode object on a
    // case-sensitive NTFS directory or any junction still fails closed.
    if (canonical.toLowerCase() !== root.toLowerCase()) reject("root-reparse");
    const [requested, resolved] = await Promise.all([
      fs.lstat(root, {bigint:true}), fs.lstat(canonical, {bigint:true})
    ]);
    if (!requested.isDirectory() || !resolved.isDirectory() ||
        requested.isSymbolicLink() || resolved.isSymbolicLink() ||
        requested.dev !== resolved.dev || requested.ino !== resolved.ino)
      reject("root-reparse");
  } else if (canonical !== root) reject("root-reparse");
}

/**
 * Ownership journal for ONE host, shared by arbitrary job roots.
 * Attestation and verified-stop callbacks are intentionally injected only
 * for a SYNTHETIC LAB. Before runtime integration use a fixed, independent
 * Windows ACL/SID attestor and trusted WSB list path, never an untrusted callback.
 */
export class HostVmJournal {
  constructor({ root, attestRoot = null } = {}) {
    if (!safeAbsolute(root)) reject("invalid-root");
    this.root = root;
    this.lock = path.join(root, ".vm-host-active");
    this.recordPath = path.join(this.lock, "owner.json");
    this.attestRoot = attestRoot;
  }

  async inspect() {
    try {
      await assertExistingNoLinks(this.root);
      const record = await this.read();
      return record ? {active:true,status:record.phase,vmId:record.vmId,
        jobId:record.jobId,requiresHumanReview:true}
      : {active:false,status:"none"};
    } catch {
      return {active:true,status:"indeterminate",requiresHumanReview:true};
    }
  }

  async read(allowReleaseGuard = false) {
    // Recheck the ENTIRE root ancestry before each mutation/read. A root swap
    // after a valid initial claim must not redirect transitions or release.
    // This still needs a native Windows handle/broker to eliminate TOCTOU.
    await assertExistingNoLinks(this.root);
    const exists = await fs.lstat(this.lock).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!exists) return null;
    if (!exists.isDirectory() || exists.isSymbolicLink()) reject("unsafe-lock");
    const entries = (await fs.readdir(this.lock)).sort();
    const expected = allowReleaseGuard ? [".release-guard","owner.json"] : ["owner.json"];
    if (entries.join(",") !== expected.join(",")) reject("partial-or-corrupt-lock");
    const stat = await fs.lstat(this.recordPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 12 || stat.size > 4096)
      reject("unsafe-record");
    return validOwner(JSON.parse(await fs.readFile(this.recordPath,"utf8")));
  }

  async claim({vmId,jobId,manifestHash,ownerSid,jobJournalRoot}) {
    if (!UUID.test(vmId) || !UUID.test(jobId) || !SHA256.test(manifestHash) ||
        !SID.test(ownerSid) || !safeAbsolute(jobJournalRoot) ||
        jobJournalRoot === this.root || this.root.startsWith(jobJournalRoot + path.sep) ||
        jobJournalRoot.startsWith(this.root + path.sep)) reject("invalid-identity-or-root");
    // NEVER auto-provision the canonical machine-owned root or its DACL.
    await assertExistingNoLinks(this.root);
    if (typeof this.attestRoot !== "function" ||
        (await this.attestRoot({root:this.root,ownerSid}))?.verified !== true)
      reject("host-acl-and-sid-not-attested");
    // The directory claim is atomic on one local NTFS volume. A crash before
    // owner.json is written leaves a conservative, non-reusable lock directory.
    try { await fs.mkdir(this.lock); }
    catch (error) {
      if (error?.code === "EEXIST") reject("occupied-requires-manual-review");
      throw error;
    }
    const now = new Date().toISOString();
    const record = validOwner({schema:VM_HOST_SCHEMA,vmId,jobId,manifestHash,
      ownerSid,jobJournalRoot,pid:process.pid,phase:"reserved",
      createdAt:now,updatedAt:now});
    await fs.writeFile(this.recordPath,JSON.stringify(record,null,2),{flag:"wx"});
    return record;
  }

  async transition(vmId, phase, ownerSid) {
    if (!UUID.test(vmId) || !SID.test(ownerSid) || !PHASES.has(phase)) reject("invalid-transition-request");
    const key = hostTransitionKey(this.root);
    // This guard must be taken SYNCHRONOUSLY, before the first await. It covers
    // separate journal objects referencing the same root in the same PID.
    if (IN_FLIGHT_HOST_TRANSITIONS.has(key)) reject("transition-in-progress");
    IN_FLIGHT_HOST_TRANSITIONS.add(key);
    try {
      const current = await this.read();
      // Only the originating process may advance its live host-wide record.
      // Same Windows account SID is not sufficient after a controller crash.
      if (!current || current.vmId !== vmId || current.ownerSid !== ownerSid ||
          current.pid !== process.pid || !TRANSITIONS[current.phase].includes(phase))
        reject("invalid-transition");
      const next = {...current,phase,updatedAt:new Date().toISOString()};
      const temp = path.join(this.lock,".owner-"+randomUUID()+".tmp");
      // If a partial transition crashes or rename fails, the unknown extra file
      // intentionally blocks future claims/release pending explicit inspection.
      await fs.writeFile(temp,JSON.stringify(next,null,2),{flag:"wx"});
      await fs.rename(temp,this.recordPath);
      return next;
    } finally {
      IN_FLIGHT_HOST_TRANSITIONS.delete(key);
    }
  }

  async releaseAfterVerifiedStop({vmId,ownerSid,jobJournal,verifyStopped}) {
    if (!UUID.test(vmId) || !SID.test(ownerSid) || typeof verifyStopped !== "function" ||
        typeof jobJournal?.inspect !== "function" ||
        typeof jobJournal?.root !== "string") reject("missing-independent-stop-proofs");
    const old = await this.read();
    if (!old || old.vmId !== vmId || old.ownerSid !== ownerSid ||
        old.phase !== "stopped" || old.jobJournalRoot !== jobJournal.root ||
        old.pid !== process.pid) reject("global-owner-not-releasable");
    const local = await jobJournal.inspect();
    if (local.active !== false || !["none","no-history"].includes(local.status))
      reject("local-journal-not-released");
    const proof = await verifyStopped({vmId,ownerSid});
    if (proof?.vmId !== vmId || proof?.ownerSid !== ownerSid ||
        proof?.verifiedAbsent !== true) reject("wsb-stop-not-independently-confirmed");

    // Serialize simultaneous release attempts; interrupted release holds lock.
    const guard = path.join(this.lock,".release-guard");
    try { await fs.mkdir(guard); }
    catch (error) {
      if (error?.code === "EEXIST") reject("release-in-progress");
      throw error;
    }
    const fresh = await this.read(true);
    if (fingerprint(fresh) !== fingerprint(old)) reject("owner-changed");
    const localAgain = await jobJournal.inspect();
    if (localAgain.active !== false || !["none","no-history"].includes(localAgain.status))
      reject("local-ownership-changed");
    await fs.unlink(this.recordPath);
    await fs.rmdir(guard);
    await fs.rmdir(this.lock);
    return {released:true,vmId,requiresManualReview:false};
  }
}

/** Production entry is Windows-only, pinned to ProgramData and denies absent ACL attestation. */
export function createCanonicalWindowsHostJournal({attestRoot} = {}) {
  if (process.platform !== "win32") reject("windows-only");
  return new HostVmJournal({root:path.win32.normalize(WINDOWS_VM_HOST_ROOT),attestRoot});
}
