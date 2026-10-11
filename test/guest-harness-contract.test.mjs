import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const harnessPath = fileURLToPath(new URL("../src/sandbox/guest-runner.ps1", import.meta.url));

test("PowerShell guest harness must keep empty stdout and stderr as JSON strings", async () => {
  const source = await fs.readFile(harnessPath, "utf8");
  assert.match(source, /stdout\s*=\s*''/);
  assert.match(source, /stderr\s*=\s*''/);
  assert.match(source, /\$report\.stdout\s*=\s*\[string\]\$stdoutTask\.Result/);
  assert.match(source, /\$report\.stderr\s*=\s*\[string\]\$stderrTask\.Result/);
  assert.match(source, /\$process\.WaitForExit\(\[int\]\$job\.timeoutSeconds \* 1000\)/);
  assert.match(source, /\$exit\s*=\s*\$process\.ExitCode/);
  assert.doesNotMatch(source, /\$report\.exitCode\s*=\s*\[int\]\$process\.ExitCode/);
});

test("guest test runner reports ASCII TAP and writes only the dedicated result file", async () => {
  const source = await fs.readFile(harnessPath, "utf8");
  assert.match(source, /--test-reporter=tap/);
  assert.match(source, /\$outputRoot\s*=\s*'C:\\StudioResults'/);
  assert.match(source, /\$target\s*=\s*Join-Path \$outputRoot 'result\.json'/);
  assert.match(source, /Move-Item -LiteralPath \$temporary -Destination \$target -Force/);
});
