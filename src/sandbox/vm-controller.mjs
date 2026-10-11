/**
 * Guarded Windows Sandbox CLI driver.
 * This module is NOT wired into the app HTTP API. Execution is opt-in from an
 * interactive user session only, after staging and verifying an isolated job.
 * Windows Sandbox is a VM; worktrees themselves are not execution isolation.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { diagnoseSandbox } from "./windows.mjs";
import { parseUntrustedRunnerResult, verifyPreparedOfflineRunnerJob } from "./offline-runner.mjs";
import { VmOwnershipJournal } from "./vm-journal.mjs";

const execFileAsync = promisify(execFile);
const VM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOWS_SID_RE = /^S-1-\d+(?:-\d+){2,15}$/i;
// Hard-coded guest command: no model output, project content or user arguments
// may be interpolated into this command line.
export const GUEST_RUNNER_COMMAND = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\StudioInput\\guest-runner.ps1";

export function parseSandboxListResponse(stdout) {
  if (typeof stdout !== "string" || stdout.length > 20000) {
    throw Error("invalid-sandbox-list-response");
  }
  let value;
  try { value = JSON.parse(stdout); }
  catch { throw Error("invalid-sandbox-list-response"); }
  if (!value || !Array.isArray(value.WindowsSandboxEnvironments) ||
      value.WindowsSandboxEnvironments.length > 256 ||
      !value.WindowsSandboxEnvironments.every(x => x && VM_ID_RE.test(x.Id))) {
    throw Error("invalid-sandbox-list-response");
  }
  return new Set(value.WindowsSandboxEnvironments.map(x => x.Id.toLowerCase()));
}

export function parseSandboxExecAcknowledgement(stdout) {
  if (typeof stdout !== "string" || stdout.length > 2048) {
    throw Error("invalid-sandbox-exec-response");
  }
  let record;
  try { record = JSON.parse(stdout); }
  catch { throw Error("invalid-sandbox-exec-response"); }
  if (!record || typeof record !== "object" ||
      !Number.isInteger(record.ExitCode) ||
      record.ExitCode < 0 || record.ExitCode > 255) {
    throw Error("invalid-sandbox-exec-response");
  }
  if (record.ExitCode !== 0) throw Error("sandbox-guest-command-failed");
  return record.ExitCode;
}

/**
 * Do not execute arbitrary PATH results. The new Microsoft Store edition ships
 * an App Execution Alias in the interactive user's WindowsApps directory; older
 * installations may provide a System32 executable. Both are known OS locations.
 */
export function windowsSandboxCliCandidates({
  localAppData = process.env.LOCALAPPDATA,
  systemRoot = process.env.SystemRoot || "C:\\Windows"
} = {}) {
  const result = [];
  function safeBase(value) {
    return typeof value === "string" && /^[A-Za-z]:\\/.test(value) &&
      value.length < 220 && !/[<>|"'*\0\r\n]/.test(value) &&
      value.split("\\").every(part => part !== ".." && part !== ".");
  }
  if (safeBase(localAppData)) {
    result.push(path.win32.join(localAppData, "Microsoft", "WindowsApps", "wsb.exe"));
  }
  if (safeBase(systemRoot)) {
    result.push(path.win32.join(systemRoot, "System32", "wsb.exe"));
  }
  return [...new Set(result.map(item => path.win32.normalize(item)))];
}
export const VM_APPROVAL_PREFIX = "RUN OFFLINE VM JOB ";

// Exit status for the manual operator CLI, not a Git approval. A guest failure
// can still be a valid untrusted report; it must not count as a successful
// CLI operation. Always refuse incomplete or inconsistent result objects.
export function manualVmExitStatus(outcome) {
  return outcome?.status === "passed" &&
    outcome?.exitCode === 0 &&
    outcome?.sandboxStopped === true &&
    outcome?.trusted === false &&
    outcome?.requiresHumanReview === true &&
    outcome?.acceptedForAutomaticApproval === false ? 0 : 2;
}
export const VM_TEST_DRIVER = "studio.vm-driver.v1";

function isServiceAccount(username) {
  const normalized = String(username || "").trim().toLowerCase();
  return !normalized || ["system", "local service", "network service"].includes(normalized) ||
    /\\(system|local service|network service)$/.test(normalized);
}

async function defaultSessionProbe() {
  const output = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "(Get-Process -Id " + process.pid + " -ErrorAction Stop).SessionId"
  ], { timeout: 6500, windowsHide: true, maxBuffer: 1000 });
  const value = String(output.stdout).trim();
  return /^\d{1,6}$/.test(value) ? Number(value) : 0;
}

async function defaultOperatorSidProbe() {
  const output = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"
  ], { timeout: 6500, windowsHide: true, maxBuffer: 1000 });
  return String(output.stdout ?? "").trim();
}

async function defaultExecutableProbe(executable) {
  // Microsoft Store App Execution Aliases are reparse points: fs.stat() can
  // fail even when "wsb --version" succeeds from the logged-on user.
  // A successful, parseable CLI response is more reliable than file metadata.
  try {
    const response = await execFileAsync(executable, ["--version"], {
      timeout: 6500, windowsHide: true, maxBuffer: 2000
    });
    return /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(String(response.stdout ?? "").trim());
  } catch {
    return false;
  }
}

/**
 * Read-only capability probe: NEVER installs features or launches a VM.
 */
export async function probeWindowsVm({
  platform = process.platform,
  username = os.userInfo().username,
  featureProbe = diagnoseSandbox,
  sessionProbe = defaultSessionProbe,
  identityProbe = defaultOperatorSidProbe,
  executableProbe = defaultExecutableProbe,
  cliCandidates = windowsSandboxCliCandidates
} = {}) {
  const base = {
    schema: VM_TEST_DRIVER, platform, featureState: "unknown",
    session: "unverified", cliPresent: false, userSid: null,
    featureReady: false, executionEnabled: false, executable: null
  };
  if (platform !== "win32") return { ...base, reason: "windows-only" };
  if (isServiceAccount(username)) {
    return { ...base, session: "service-account", reason: "interactive-user-required" };
  }
  let sessionId;
  try { sessionId = await sessionProbe(); } catch { sessionId = 0; }
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return { ...base, session: "non-interactive", reason: "interactive-session-required" };
  }
  base.session = "interactive";
  const feature = await featureProbe();
  base.featureState = String(feature?.featureState || "unknown");
  if (base.featureState !== "Enabled") {
    return { ...base, reason: "windows-sandbox-feature-not-enabled" };
  }
  const candidates = cliCandidates();
  for (const executable of candidates) {
    if (await executableProbe(executable)) {
      let sid = null;
      try { sid = await identityProbe(); } catch { /* unverified operator */ }
      if (!WINDOWS_SID_RE.test(sid)) {
        return { ...base, cliPresent: true, executable,
          reason: "operator-windows-sid-unavailable" };
      }
      return { ...base, cliPresent: true, executable, userSid: sid,
        featureReady: true, reason: "explicit-approval-required" };
    }
  }
  return { ...base, reason: "sandbox-cli-not-installed" };
}

export function expectedVmApproval(staged) {
  if (!staged || !VM_ID_RE.test(staged.id) ||
      !/^[a-f0-9]{64}$/.test(staged.manifestHash)) {
    throw Error("invalid-staged-job-identity");
  }
  return VM_APPROVAL_PREFIX + staged.id + " " + staged.manifestHash.slice(0, 12);
}

function delayWithSignal(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? Error("vm-run-cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      signal?.removeEventListener("abort", cancelled);
      resolve();
    }
    function cancelled() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      reject(signal.reason ?? Error("vm-run-cancelled"));
    }
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

async function readGuestReport(outputDir) {
  const report = path.join(outputDir, "result.json");
  try {
    const stat = await fs.lstat(report);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 70000) {
      throw Error("unsafe-vm-result");
    }
    const content = await fs.readFile(report, "utf8");
    return content;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Run one prepared job in a real Windows Sandbox instance.
 * Explicit local opt-in and console confirmation are mandatory.
 * A success reported by the guest is always untrusted and requires review.
 *
 * vmCommand is injectable for NON-EXECUTING simulated tests; never exposed to a
 * web route. Actual command calls use execFile (no shell interpolation).
 */
export async function runWindowsVmJob({
  staged, approval, executionOptIn = false, interactiveConfirmation = false,
  signal, readinessProbe = probeWindowsVm,
  preflight = verifyPreparedOfflineRunnerJob,
  vmCommand = async (executable, args, options) => execFileAsync(executable, args, options),
  reportReader = readGuestReport,
  wait = delayWithSignal, now = () => performance.now(),
  vmId = randomUUID(), pollMs = 1000, startupGraceMs = 90000, guestBootWaitMs = 6000,
  journal = null, onEvent = () => {}
}) {
  if (!executionOptIn || !interactiveConfirmation || approval !== expectedVmApproval(staged)) {
    throw Error("explicit-vm-approval-required");
  }
  if (!(journal instanceof VmOwnershipJournal)) {
    throw Error("vm-ownership-journal-required");
  }
  if (!VM_ID_RE.test(vmId) ||
      !Number.isInteger(pollMs) || pollMs < 100 || pollMs > 10000 ||
      !Number.isInteger(startupGraceMs) || startupGraceMs < 1000 || startupGraceMs > 180000 ||
      !Number.isInteger(guestBootWaitMs) || guestBootWaitMs < 0 || guestBootWaitMs > 30000) {
    throw Error("invalid-vm-control-options");
  }
  if (!staged.manifest || staged.manifest.id !== staged.id ||
      staged.manifest.manifestHash !== staged.manifestHash ||
      !Number.isInteger(staged.manifest.timeoutSeconds) ||
      staged.manifest.timeoutSeconds < 5 || staged.manifest.timeoutSeconds > 120) {
    throw Error("inconsistent-staged-manifest");
  }
  signal?.throwIfAborted();
  const ready = await readinessProbe();
  if (!ready?.featureReady || ready.platform !== "win32" ||
      ready.session !== "interactive" || !ready.cliPresent) {
    throw Error("vm-host-not-ready:" + String(ready?.reason || "unknown"));
  }
  if (!WINDOWS_SID_RE.test(ready.userSid)) {
    throw Error("vm-operator-windows-sid-required");
  }
  const configPath = staged.configPath;
  if (typeof configPath !== "string" || !path.isAbsolute(configPath) ||
      typeof staged.outputDir !== "string" || !path.isAbsolute(staged.outputDir) ||
      path.dirname(configPath) !== path.dirname(staged.outputDir) ||
      path.basename(configPath).toLowerCase() !== "job.wsb") {
    throw Error("untrusted-job-paths");
  }
  const attestation = await preflight({
    jobRoot: path.dirname(configPath),
    expectedManifestHash: staged.manifestHash,
    expectedRuntimeSha256: staged.runtimeSha256
  });
  if (attestation?.verified !== true || attestation?.executionEnabled !== false ||
      attestation?.manifestHash !== staged.manifestHash ||
      attestation?.id !== staged.id) throw Error("runner-preflight-not-verified");
  signal?.throwIfAborted();
  const config = await fs.readFile(configPath, "utf8");
  const maxMs = startupGraceMs + staged.manifest.timeoutSeconds * 1000;
  const startAt = now();
  let attempted = false, journalClaimed = false, result = null;
  let primaryError = null, stopError = null, journalError = null;
  const emit = event => {
    try { onEvent(event); } catch { /* observability cannot block VM cleanup */ }
  };
  try {
    if (journal) {
      await journal.claim({ vmId, jobId: staged.id,
        manifestHash: staged.manifestHash, ownerSid: ready.userSid });
      journalClaimed = true;
      await journal.transition(vmId, "launch-requested");
    }
    signal?.throwIfAborted();
    attempted = true;
    emit({ stage: "starting", vmId, jobId: staged.id });
    await vmCommand(ready.executable, [
      "start", "--id", vmId, "--config", config
    ], { timeout: 60000, windowsHide: true, maxBuffer: 20000, signal });
    if (journal) await journal.transition(vmId, "running");
    emit({ stage: "running", vmId, jobId: staged.id });
    // The Store CLI does not run LogonCommand until a guest user logs in.
    // Explicit execution in the guest SYSTEM session works headlessly.
    // Do not retry ambiguous execution failures: the command may have started.
    if (guestBootWaitMs) await wait(guestBootWaitMs, signal);
    signal?.throwIfAborted();
    emit({ stage: "guest-command", vmId, jobId: staged.id });
    const acknowledgement = await vmCommand(ready.executable, [
      "exec", "--id", vmId, "--command", GUEST_RUNNER_COMMAND,
      "--run-as", "System", "--raw"
    ], { timeout: maxMs, windowsHide: true, maxBuffer: 20000, signal });
    parseSandboxExecAcknowledgement(acknowledgement?.stdout);
    while (now() - startAt < maxMs) {
      signal?.throwIfAborted();
      const raw = await reportReader(staged.outputDir);
      if (raw !== null) {
        const parsed = parseUntrustedRunnerResult(raw, staged.manifest);
        result = {
          vmId, jobId: staged.id, execution: "guest-reported",
          ...parsed, acceptedForAutomaticApproval: false
        };
        break;
      }
      await wait(pollMs, signal);
    }
    if (!result) throw Error("vm-guest-report-timeout");
  } catch (error) {
    primaryError = error;
  } finally {
    if (attempted) {
      emit({ stage: "stopping", vmId, jobId: staged.id });
      if (journalClaimed) {
        try { await journal.transition(vmId, "stopping"); }
        catch (error) { journalError = error; }
      }
      let stopped = false;
      try {
        await vmCommand(ready.executable, ["stop", "--id", vmId], {
          timeout: 25000, windowsHide: true, maxBuffer: 20000
        });
        // Exit code 0 from 'wsb stop' is not proof of VM termination.
        // Query live VM sessions using the same user identity before releasing
        // the durable ownership record.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await wait(800);
          const listed = await vmCommand(ready.executable, ["list", "--raw"], {
            timeout: 14000, windowsHide: true, maxBuffer: 20000
          });
          if (!parseSandboxListResponse(listed?.stdout).has(vmId.toLowerCase())) {
            stopped = true;
            break;
          }
        }
        if (!stopped) throw Error("vm-still-running-after-stop");
        emit({ stage: "stopped", vmId, jobId: staged.id });
      } catch (error) {
        stopError = Error("vm-stop-not-confirmed; inspect session " + vmId + " manually", { cause: error });
      }
      if (journalClaimed) {
        try {
          if (stopped) {
            await journal.transition(vmId, "stopped");
            await journal.releaseStopped(vmId);
          } else {
            await journal.transition(vmId, "stop-unverified");
          }
        } catch (error) { journalError = error; }
      }
    } else if (journalClaimed) {
      // No VM launch was attempted. Clear the reservation only after the
      // journal has recorded that no VM still needs to be stopped.
      try {
        await journal.transition(vmId, "stopped");
        await journal.releaseStopped(vmId);
      } catch (error) { journalError = error; }
    }
  }
  const errors = [primaryError, stopError, journalError].filter(Boolean);
  if (errors.length > 1) throw new AggregateError(errors, "vm-lifecycle-or-ownership-error");
  if (errors.length === 1) throw errors[0];
  return { ...result, sandboxStopped: true, requiresHumanReview: true };
}
