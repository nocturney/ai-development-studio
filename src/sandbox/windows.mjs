import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
export const SANDBOX_FEATURE = "Containers-DisposableClientVM";

export async function diagnoseSandbox({
  platform = process.platform,
  execFileImpl = execFileAsync
} = {}) {
  if (platform !== "win32") {
    return { platform, feature: SANDBOX_FEATURE, featureState: "not-windows",
      executionEnabled: false, reason: "unsupported-host", requiresRestart: false };
  }
  // Win32_OptionalFeature can be queried from a standard interactive user.
  // DISM's Get-WindowsOptionalFeature often requires elevation; keep it as a
  // fallback when the CIM provider is unavailable or returns unknown data.
  const commands = [
    "$f=Get-CimInstance -ClassName Win32_OptionalFeature -Filter \"Name='Containers-DisposableClientVM'\" -ErrorAction Stop; if ($null -eq $f) { throw 'feature-not-found' }; $f.InstallState",
    '(Get-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -ErrorAction Stop).State'
  ];
  for (const command of commands) {
    try {
      const result = await execFileImpl("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", command
      ], { timeout: 16000, windowsHide: true, maxBuffer: 8192 });
      const raw = String(result.stdout || "").trim().split(/\r?\n/).at(-1).trim();
      const state = ({ "1": "Enabled", "2": "Disabled", "3": "Absent" })[raw] ?? raw;
      if (!["Enabled", "Disabled", "Absent"].includes(state)) continue;
      const enabled = state === "Enabled";
      return {
        platform, feature: SANDBOX_FEATURE, featureState: state,
        executionEnabled: false,
        reason: enabled ? "manual-vm-controller-gated" : "windows-sandbox-not-enabled",
        requiresRestart: !enabled
      };
    } catch {
      // Try the next read-only source. Never assume a feature is enabled.
    }
  }
  return { platform, feature: SANDBOX_FEATURE, featureState: "unknown",
    executionEnabled: false, reason: "feature-query-failed", requiresRestart: null };
}

function encodeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function createSandboxProfile({ readonlyInputPath, memoryMB = 4096 }) {
  if (typeof readonlyInputPath !== "string" ||
    !path.win32.isAbsolute(readonlyInputPath) ||
    !/^[a-zA-Z]:\\/.test(readonlyInputPath) ||
    /[<>"'\0\r\n]/.test(readonlyInputPath)) {
    throw new Error("invalid-sandbox-input-path");
  }
  if (!Number.isInteger(memoryMB) || memoryMB < 4096 || memoryMB > 16384) {
    throw new Error("invalid-sandbox-memory");
  }
  const source = encodeXml(path.win32.normalize(readonlyInputPath));
  return [
    "<Configuration>",
    "  <vGPU>Disable</vGPU>",
    "  <Networking>Disable</Networking>",
    "  <AudioInput>Disable</AudioInput>",
    "  <VideoInput>Disable</VideoInput>",
    "  <ProtectedClient>Enable</ProtectedClient>",
    "  <PrinterRedirection>Disable</PrinterRedirection>",
    "  <ClipboardRedirection>Disable</ClipboardRedirection>",
    "  <MemoryInMB>" + memoryMB + "</MemoryInMB>",
    "  <MappedFolders>",
    "    <MappedFolder>",
    "      <HostFolder>" + source + "</HostFolder>",
    "      <SandboxFolder>C:\\PilotInput</SandboxFolder>",
    "      <ReadOnly>true</ReadOnly>",
    "    </MappedFolder>",
    "  </MappedFolders>",
    "</Configuration>"
  ].join("\n") + "\n";
}
