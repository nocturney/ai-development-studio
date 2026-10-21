/**
 * Read-only native Windows readiness proof for the canonical VM host root.
 *
 * The probe script is FIXED: it takes no caller input and only reads identity,
 * session, elevation, reparse points and the ACL of WINDOWS_VM_HOST_ROOT. It
 * never writes, changes ACLs, starts Windows Sandbox or grants any approval.
 * Only collectNativeHostFacts() is a trust source; evaluateNativeHostFacts() is
 * a pure policy function and must never be fed by a model or web input.
 */
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { WINDOWS_VM_HOST_ROOT } from "./vm-host-coordinator.mjs";

const execFileAsync = promisify(execFile);
export const VM_HOST_READINESS_SCHEMA = "studio.vm-host-readiness.v1";
export const EXPECTED_OPERATOR_ACCOUNT = "CHRIS\\Chris";
const SID = /^S-1-\d+(?:-\d+){1,15}$/i;
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const FULL_CONTROL = 0x1f01ff;
// Any of these bits on an Allow ACE means the principal can alter the root.
const WRITE_MASK = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 |
  0x40000000 | 0x10000000;
const MAX_OUTPUT = 16384;
const MAX_RULES = 64;

// Fixed script: only the canonical constant is interpolated, never caller data.
const NATIVE_PROBE = `
$ErrorActionPreference = 'Stop'
$root = '${WINDOWS_VM_HOST_ROOT}'
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($id)
$elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$reparse = @()
foreach ($p in @('C:\\', 'C:\\ProgramData', 'C:\\ProgramData\\AIStudio', $root)) {
  if (Test-Path -LiteralPath $p) {
    $item = Get-Item -LiteralPath $p -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $reparse += $p }
  }
}
$out = [ordered]@{
  user = [ordered]@{ name = $id.Name; sid = $id.User.Value }
  session = [int](Get-Process -Id $PID).SessionId
  elevated = [bool]$elevated
  rootPresent = [bool](Test-Path -LiteralPath $root -PathType Container)
  reparsePoints = @($reparse)
}
if ($out.rootPresent) {
  $acl = Get-Acl -LiteralPath $root
  $out.owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $out.protected = [bool]$acl.AreAccessRulesProtected
  $out.rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    [ordered]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString();
      rights = [int]$_.FileSystemRights; inherited = [bool]$_.IsInherited }
  })
}
$out | ConvertTo-Json -Depth 5 -Compress
`;

function verdictFor(reason, facts = null) {
  return {
    schema: VM_HOST_READINESS_SCHEMA,
    ready: reason === "native-host-root-ready",
    reason,
    root: WINDOWS_VM_HOST_ROOT,
    operatorSid: facts?.user?.sid ?? null,
    executionEnabled: false,
    mutationAttempted: false,
    sandboxStartAttempted: false,
    note: "Read-only native ACL/identity proof. Not an authorized broker or VM launch approval."
  };
}

/** Strict shape check for the probe output. Untrusted text is never trusted by shape alone. */
export function parseNativeHostFacts(stdout) {
  const fail = () => { throw Error("native-host-facts-invalid"); };
  if (typeof stdout !== "string" || stdout.length > MAX_OUTPUT) fail();
  let value;
  try { value = JSON.parse(stdout); } catch { fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  if (typeof value.user?.name !== "string" || !SID.test(value.user?.sid ?? "")) fail();
  if (!Number.isInteger(value.session) || typeof value.elevated !== "boolean" ||
      typeof value.rootPresent !== "boolean" || !Array.isArray(value.reparsePoints) ||
      !value.reparsePoints.every(item => typeof item === "string")) fail();
  if (value.rootPresent) {
    if (!SID.test(value.owner ?? "") || typeof value.protected !== "boolean" ||
        !Array.isArray(value.rules) || value.rules.length > MAX_RULES) fail();
    for (const rule of value.rules) {
      if (!SID.test(rule?.sid ?? "") || !["Allow","Deny"].includes(rule.type) ||
          !Number.isInteger(rule.rights) || rule.rights < 0 || rule.rights > 0xffffffff ||
          typeof rule.inherited !== "boolean") fail();
    }
  }
  return value;
}

/**
 * Pure policy. Requires an interactive, elevated EXPECTED_OPERATOR_ACCOUNT whose
 * Administrators membership grants FullControl through a protected SYSTEM-owned
 * root, and where no other principal can write.
 */
export function evaluateNativeHostFacts(facts) {
  if (facts?.platform !== "win32") return verdictFor("windows-only");
  if (String(facts.user?.name ?? "").toLowerCase() !== EXPECTED_OPERATOR_ACCOUNT.toLowerCase())
    return verdictFor("wrong-operator-account", facts);
  const sid = facts.user?.sid ?? "";
  if (!SID.test(sid) || sid.toUpperCase() === SYSTEM_SID.toUpperCase() || sid.startsWith("S-1-5-80-"))
    return verdictFor("service-identity", facts);
  if (facts.session === 0) return verdictFor("session-zero", facts);
  if (!(facts.session >= 1)) return verdictFor("non-interactive-session", facts);
  if (facts.elevated !== true) return verdictFor("non-elevated-token", facts);
  if (facts.rootPresent !== true) return verdictFor("root-absent", facts);
  if (facts.reparsePoints.length > 0) return verdictFor("root-reparse", facts);
  if (facts.owner?.toUpperCase() !== SYSTEM_SID) return verdictFor("root-owner-not-system", facts);
  if (facts.protected !== true) return verdictFor("root-acl-unprotected", facts);
  const isWriter = sid2 => [SYSTEM_SID, ADMINISTRATORS_SID].includes(sid2.toUpperCase());
  for (const rule of facts.rules) {
    if (rule.inherited) return verdictFor("root-acl-unprotected", facts);
    if (rule.type === "Deny") return verdictFor("deny-ace-present", facts);
    if (!isWriter(rule.sid) && (rule.rights & WRITE_MASK) !== 0) return verdictFor("mutable-root-acl", facts);
  }
  const grants = sid2 => facts.rules.some(rule => rule.type === "Allow" &&
    rule.sid.toUpperCase() === sid2 && (rule.rights & FULL_CONTROL) === FULL_CONTROL);
  if (!grants(SYSTEM_SID) || !grants(ADMINISTRATORS_SID))
    return verdictFor("root-acl-missing-full-control", facts);
  return verdictFor("native-host-root-ready", facts);
}

/** Fixed, parameterless probe. Returns verified parsed facts or throws. */
export async function collectNativeHostFacts() {
  const output = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", NATIVE_PROBE
  ], { timeout: 16000, windowsHide: true, maxBuffer: MAX_OUTPUT });
  return parseNativeHostFacts(String(output.stdout ?? ""));
}

/** Full read-only check: never accepts facts from the caller. */
export async function checkVmHostReadiness() {
  if (process.platform !== "win32") return verdictFor("windows-only");
  let facts;
  try { facts = await collectNativeHostFacts(); }
  catch { return verdictFor("native-facts-unavailable"); }
  return evaluateNativeHostFacts({ platform: "win32", ...facts });
}

/**
 * Optional HostVmJournal attestRoot. It only returns verified:true when the
 * fixed native probe passes AND the requested owner is this interactive operator.
 * Not wired into manual-vm-runner, which still refuses VM launch.
 */
export async function attestWindowsVmHostRoot({ root, ownerSid } = {}) {
  if (root !== path.win32.normalize(WINDOWS_VM_HOST_ROOT)) return { verified: false, reason: "root-not-canonical" };
  const verdict = await checkVmHostReadiness();
  if (!verdict.ready) return { verified: false, reason: verdict.reason };
  if (String(ownerSid).toUpperCase() !== String(verdict.operatorSid).toUpperCase()) {
    return { verified: false, reason: "operator-sid-mismatch" };
  }
  return { verified: true, reason: verdict.reason };
}
