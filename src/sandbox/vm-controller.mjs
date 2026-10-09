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

const execFileAsync = promisify(execFile);
const VM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_WSB = path.win32.join(
  process.env.SystemRoot || "C:\\Windows", "System32", "wsb.exe"
);
export const VM_APPROVAL_PREFIX = "RUN OFFLINE VM JOB ";
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

async function defaultExecutableProbe(executable) {
  try {
    const file = await fs.stat(executable);
    return file.isFile();
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
  executableProbe = defaultExecutableProbe,
  executable = DEFAULT_WSB
} = {}) {
  const base = {
    schema: VM_TEST_DRIVER, platform, featureState: "unknown",
    session: "unverified", cliPresent: false,
    featureReady: false, executionEnabled: false, executable
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
  base.cliPresent = await executableProbe(executable);
  if (!base.cliPresent) return { ...base, reason: "sandbox-cli-not-installed" };
  return { ...base, featureReady: true, reason: "explicit-approval-required" };
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
  vmId = randomUUID(), pollMs = 1000, startupGraceMs = 90000,
  onEvent = () => {}
}) {
  if (!executionOptIn || !interactiveConfirmation || approval !== expectedVmApproval(staged)) {
    throw Error("explicit-vm-approval-required");
  }
  if (!VM_ID_RE.test(vmId) ||
      !Number.isInteger(pollMs) || pollMs < 100 || pollMs > 10000 ||
      !Number.isInteger(startupGraceMs) || startupGraceMs < 1000 || startupGraceMs > 180000) {
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
  let attempted = false, result = null, primaryError = null, stopError = null;
  const emit = event => {
    try { onEvent(event); } catch { /* observability cannot block VM cleanup */ }
  };
  try {
    attempted = true;
    emit({ stage: "starting", vmId, jobId: staged.id });
    await vmCommand(ready.executable, [
      "start", "--id", vmId, "--config", config
    ], { timeout: 60000, windowsHide: true, maxBuffer: 20000, signal });
    emit({ stage: "running", vmId, jobId: staged.id });
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
      try {
        await vmCommand(ready.executable, ["stop", "--id", vmId], {
          timeout: 25000, windowsHide: true, maxBuffer: 20000
        });
        emit({ stage: "stopped", vmId, jobId: staged.id });
      } catch (error) {
        stopError = Error("vm-stop-not-confirmed; inspect session " + vmId + " manually", { cause: error });
      }
    }
  }
  if (primaryError && stopError) throw new AggregateError([primaryError, stopError], "vm-failed-and-stop-unverified");
  if (stopError) throw stopError;
  if (primaryError) throw primaryError;
  return { ...result, sandboxStopped: true, requiresHumanReview: true };
}
