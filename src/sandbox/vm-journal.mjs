/**
 * Per-operator VM ownership journal. Durable failure is safer than accidentally
 * starting a second Sandbox after the controlling process crashes.
 * A stale journal is NEVER automatically cleared or used to stop an arbitrary VM.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const SID = /^S-1-\d+(?:-\d+){2,15}$/i;
const PHASES = new Set([
  "reserved", "launch-requested", "running", "stopping",
  "stopped", "stop-unverified"
]);
const TRANSITIONS = {
  reserved: ["launch-requested", "stopped"],
  "launch-requested": ["running", "stopping", "stopped", "stop-unverified"],
  running: ["stopping", "stop-unverified"],
  stopping: ["stopped", "stop-unverified"],
  stopped: [],
  "stop-unverified": []
};

export const VM_JOURNAL_SCHEMA = "studio.vm-ownership.v1";

export function vmOwnershipFingerprint(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw Error("invalid-vm-owner-fingerprint-input");
  }
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

export class VmOwnershipJournal {
  constructor(root) {
    if (typeof root !== "string" || !path.isAbsolute(root) ||
        path.resolve(root) === path.parse(root).root ||
        root.length > 235 || root.includes("\0")) {
      throw Error("invalid-vm-journal-root");
    }
    this.root = path.resolve(root);
    this.lock = path.join(this.root, ".vm-active");
    this.record = path.join(this.lock, "owner.json");
  }

  async checkSafeRoot({ create = false } = {}) {
    if (create) await fs.mkdir(this.root, { recursive: true });
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        path.normalize(await fs.realpath(this.root)).toLowerCase() !==
        path.normalize(this.root).toLowerCase()) {
      throw Error("unsafe-vm-journal-directory");
    }
  }

  validateRecord(item) {
    if (!item || item.schema !== VM_JOURNAL_SCHEMA ||
        !UUID.test(item.vmId) || !UUID.test(item.jobId) ||
        !HASH.test(item.manifestHash) || !PHASES.has(item.phase) ||
        (item.ownerSid != null && !SID.test(item.ownerSid)) ||
        typeof item.startedAt !== "string" || typeof item.updatedAt !== "string") {
      throw Error("invalid-vm-owner-record");
    }
    return item;
  }

  async read() {
    const lockStat = await fs.lstat(this.lock).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!lockStat) return null;
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
      throw Error("unsafe-vm-owner-lock");
    }
    const stat = await fs.lstat(this.record);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 3000) {
      throw Error("unsafe-vm-owner-record");
    }
    return this.validateRecord(JSON.parse(await fs.readFile(this.record, "utf8")));
  }

  async inspect() {
    try {
      await this.checkSafeRoot();
    } catch (error) {
      if (error.code === "ENOENT") return { active: false, status: "no-history" };
      throw error;
    }
    try {
      const record = await this.read();
      if (!record) return { active: false, status: "none" };
      return { active: true, status: record.phase, vmId: record.vmId,
        jobId: record.jobId, updatedAt: record.updatedAt,
        requiresManualReview: true };
    } catch {
      return { active: true, status: "indeterminate",
        requiresManualReview: true };
    }
  }

  async claim({ vmId, jobId, manifestHash, ownerSid = null }) {
    if (!UUID.test(vmId) || !UUID.test(jobId) || !HASH.test(manifestHash) ||
        (ownerSid !== null && !SID.test(ownerSid))) {
      throw Error("invalid-vm-ownership-identity");
    }
    await this.checkSafeRoot({ create: true });
    try {
      await fs.mkdir(this.lock);
    } catch (error) {
      if (error.code === "EEXIST") throw Error("vm-ownership-locked-requires-review");
      throw error;
    }
    const record = {
      schema: VM_JOURNAL_SCHEMA, vmId, jobId, manifestHash, ownerSid,
      phase: "reserved", pid: process.pid,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    // A partial/missing file after a crash remains a fail-closed lock.
    await fs.writeFile(this.record, JSON.stringify(record, null, 2), { flag: "wx" });
    return record;
  }

  async transition(vmId, phase) {
    if (!PHASES.has(phase)) throw Error("invalid-vm-journal-phase");
    const record = await this.read();
    if (!record || record.vmId !== vmId || !TRANSITIONS[record.phase].includes(phase)) {
      throw Error("invalid-vm-owner-transition");
    }
    const next = { ...record, phase, updatedAt: new Date().toISOString() };
    const temporary = path.join(this.lock, ".owner-" + randomUUID() + ".tmp");
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2), { flag: "wx" });
      await fs.rename(temporary, this.record);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    return next;
  }

  /**
   * Only for the explicit, operator-verified recovery flow. The caller must
   * independently prove the owning process is gone and the user's WSB session
   * list is empty twice. This method still refuses any record change or extra
   * content in the lock directory, and never starts/stops a VM.
   */
  async releaseAfterManualRecovery({ vmId, expectedFingerprint }) {
    if (!UUID.test(vmId) || !HASH.test(expectedFingerprint)) {
      throw Error("invalid-vm-recovery-identity");
    }
    const current = await this.read();
    if (!current || current.vmId !== vmId ||
        vmOwnershipFingerprint(current) !== expectedFingerprint) {
      throw Error("vm-owner-record-changed-during-recovery");
    }
    const entries = await fs.readdir(this.lock);
    if (entries.length !== 1 || entries[0] !== "owner.json") {
      throw Error("vm-owner-lock-has-unexpected-content");
    }
    if (current.phase !== "stopped") {
      const next = { ...current, phase: "stopped",
        updatedAt: new Date().toISOString(),
        manuallyRecoveredAt: new Date().toISOString() };
      const temporary = path.join(this.lock, ".owner-" + randomUUID() + ".tmp");
      try {
        await fs.writeFile(temporary, JSON.stringify(next, null, 2), { flag: "wx" });
        await fs.rename(temporary, this.record);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    }
    return this.releaseStopped(vmId);
  }

  async releaseStopped(vmId) {
    const current = await this.read();
    if (!current || current.vmId !== vmId || current.phase !== "stopped") {
      throw Error("vm-stop-not-recorded");
    }
    const entries = await fs.readdir(this.lock);
    if (entries.length !== 1 || entries[0] !== "owner.json") {
      throw Error("vm-owner-lock-has-unexpected-content");
    }
    await fs.unlink(this.record);
    await fs.rmdir(this.lock);
    return { released: true, vmId };
  }
}
