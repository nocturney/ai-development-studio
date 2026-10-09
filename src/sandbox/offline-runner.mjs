import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_SUFFIXES = new Set([".mjs", ".js", ".cjs", ".json", ".html", ".css", ".md", ".txt"]);
export const RUNNER_SCHEMA = "studio.runner.v1";
const RUNNER_SCRIPT = fileURLToPath(new URL("./guest-runner.ps1", import.meta.url));

export function safeRelativeFile(name) {
  if (typeof name !== "string" || name.length < 1 || name.length > 170 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes("//") ||
      name.includes("\\") || path.posix.isAbsolute(name)) throw Error("unsafe-relative-path");
  const segments = name.split("/");
  if (segments.some(x => {
    const lower = x.toLowerCase();
    const base = lower.split(".")[0];
    return ["", ".", "..", ".git", "node_modules", "secrets"].includes(lower) ||
      x.startsWith(".") || /[. ]$/.test(x) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(base) ||
      x.includes(":") || x.includes("~");
  })) throw Error("unsafe-relative-path");
  if (!SUPPORTED_SUFFIXES.has(path.posix.extname(name).toLowerCase())) {
    throw Error("unsupported-source-extension");
  }
  return name;
}

function safeWindowsDir(dir) {
  if (typeof dir !== "string" || dir.length < 4 || dir.length > 220 ||
      !/^[A-Za-z]:\\/.test(dir) || /[\r\n"'<>|&^%*!?]/.test(dir) ||
      dir.includes("..") || dir.includes("\\\\") || dir.endsWith("\\") ||
      /[\x00-\x1f]/.test(dir)) throw Error("unsafe-sandbox-mapped-folder");
  return path.win32.normalize(dir);
}

export function createOfflineRunnerProfile({ inputHostFolder, outputHostFolder, memoryMB = 6144 }) {
  const source = safeWindowsDir(inputHostFolder);
  const result = safeWindowsDir(outputHostFolder);
  const a = source.toLowerCase(), b = result.toLowerCase();
  if (a === b || a.startsWith(b + "\\") || b.startsWith(a + "\\")) {
    throw Error("sandbox-input-output-overlap");
  }
  if (!Number.isInteger(memoryMB) || memoryMB < 4096 || memoryMB > 16384) {
    throw Error("invalid-sandbox-memory");
  }
  // The only writable mapping is a dedicated, newly created result directory.
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
    "    <MappedFolder><HostFolder>" + source + "</HostFolder><SandboxFolder>C:\\StudioInput</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>",
    "    <MappedFolder><HostFolder>" + result + "</HostFolder><SandboxFolder>C:\\StudioResults</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>",
    "  </MappedFolders>",
    "  <LogonCommand><Command>powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\StudioInput\\guest-runner.ps1</Command></LogonCommand>",
    "</Configuration>"
  ].join("\n") + "\n";
}

export function defineOfflineJob({ id = randomUUID(), sources, tests, timeoutSeconds = 60, memoryMB = 6144 }) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,28}$/.test(id)) throw Error("invalid-runner-job-id");
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) throw Error("invalid-runner-sources");
  const entries = Object.entries(sources).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length < 1 || entries.length > 64) throw Error("invalid-source-count");
  let total = 0;
  const files = entries.map(([name, content]) => {
    safeRelativeFile(name);
    if (typeof content !== "string" || content.includes("\0")) throw Error("invalid-source-content");
    const size = Buffer.byteLength(content, "utf8");
    total += size;
    if (size < 1 || size > 512 * 1024) throw Error("invalid-source-size");
    return { name, bytes: size, sha256: createHash("sha256").update(content).digest("hex") };
  });
  if (total > 4 * 1024 * 1024) throw Error("runner-input-too-large");
  const caseFolded = files.map(file => file.name.toLowerCase());
  if (new Set(caseFolded).size !== caseFolded.length) throw Error("duplicate-case-insensitive-path");
  if (!Array.isArray(tests) || tests.length < 1 || tests.length > 16 ||
      !tests.every(name => typeof name === "string" && /\.(test|spec)\.mjs$/.test(name) &&
        files.some(file => file.name === name)) || new Set(tests).size !== tests.length) {
    throw Error("invalid-runner-test-files");
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 120) {
    throw Error("invalid-runner-timeout");
  }
  if (!Number.isInteger(memoryMB) || memoryMB < 4096 || memoryMB > 16384) throw Error("invalid-sandbox-memory");
  const manifest = {
    schema: RUNNER_SCHEMA, id, kind: "node-offline-tests",
    files, tests: [...tests].sort(), timeoutSeconds, memoryMB,
    network: "disabled", executionPolicy: "vm-only"
  };
  const manifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  return { ...manifest, manifestHash };
}

async function requireNewDir(dir) {
  await fs.mkdir(dir, { recursive: false });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("unsafe-job-directory");
}

async function copyAndHash(source, target) {
  const stats = await fs.lstat(source);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 150 * 1024 * 1024) throw Error("untrusted-node-runtime");
  await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  const bytes = await fs.readFile(target);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function stageOfflineRunnerJob({
  stagingRoot, sources, tests, nodeExecutable,
  jobId = randomUUID(), timeoutSeconds = 60, memoryMB = 6144
}) {
  if (process.platform !== "win32") throw Error("windows-runner-package-only");
  if (typeof stagingRoot !== "string" || !path.isAbsolute(stagingRoot) ||
      typeof nodeExecutable !== "string" || !path.isAbsolute(nodeExecutable) ||
      path.basename(nodeExecutable).toLowerCase() !== "node.exe") {
    throw Error("invalid-runner-staging-path");
  }
  const rootStat = await fs.lstat(stagingRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      (await fs.realpath(stagingRoot)).toLowerCase() !== path.resolve(stagingRoot).toLowerCase()) {
    throw Error("unsafe-runner-root");
  }
  const manifest = defineOfflineJob({ id: jobId, sources, tests, timeoutSeconds, memoryMB });
  const root = path.join(stagingRoot, jobId);
  await requireNewDir(root);
  const bundle = path.join(root, "bundle");
  const output = path.join(root, "output");
  await requireNewDir(bundle);
  await requireNewDir(output);
  try {
    for (const [name, content] of Object.entries(sources)) {
      const dest = path.join(bundle, "source", ...name.split("/"));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, content, { flag: "wx" });
    }
    const runtimeHash = await copyAndHash(nodeExecutable, path.join(bundle, "node.exe"));
    const script = await fs.readFile(RUNNER_SCRIPT);
    await fs.writeFile(path.join(bundle, "guest-runner.ps1"), script, { flag: "wx" });
    await fs.writeFile(path.join(bundle, "job.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
    const wsb = createOfflineRunnerProfile({
      inputHostFolder: bundle, outputHostFolder: output, memoryMB
    });
    await fs.writeFile(path.join(root, "job.wsb"), wsb, { flag: "wx" });
    return {
      id: jobId, manifestHash: manifest.manifestHash, manifest,
      configPath: path.join(root, "job.wsb"), outputDir: output,
      runtimeSha256: runtimeHash, status: "prepared-not-executed",
      executionEnabled: false
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function parseUntrustedRunnerResult(raw, manifest) {
  if (typeof raw !== "string" || raw.length > 70000) throw Error("invalid-runner-result-size");
  const record = JSON.parse(raw);
  if (record?.schema !== RUNNER_SCHEMA || record.id !== manifest.id ||
      record.manifestHash !== manifest.manifestHash ||
      !["passed", "failed", "timeout", "error"].includes(record.status) ||
      !Number.isInteger(record.exitCode) || record.exitCode < -1 || record.exitCode > 255 ||
      (record.status === "passed" && record.exitCode !== 0) ||
      (record.status === "failed" && (record.exitCode <= 0)) ||
      (["timeout", "error"].includes(record.status) && record.exitCode !== -1) ||
      !Number.isInteger(record.elapsedMs) || record.elapsedMs < 0 ||
      record.elapsedMs > (manifest.timeoutSeconds + 30) * 1000 ||
      typeof record.stdout !== "string" || typeof record.stderr !== "string" ||
      record.stdout.length > 32000 || record.stderr.length > 32000) {
    throw Error("invalid-runner-result");
  }
  return { ...record, trusted: false, requiresHumanReview: true };
}
