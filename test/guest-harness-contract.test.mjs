import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const harnessPath = fileURLToPath(new URL("../src/sandbox/guest-runner.ps1", import.meta.url));

test("PowerShell guest harness invokes sealed bounded capture and preserves JSON report fields", async () => {
  const source = await fs.readFile(harnessPath, "utf8");
  const guard = await fs.readFile(new URL("../src/sandbox/guest-bounded-process.ps1", import.meta.url), "utf8");
  assert.match(source, /stdout\s*=\s*''/);
  assert.match(source, /stderr\s*=\s*''/);
  assert.match(source, /guest-bounded-process\.ps1/);
  assert.match(source, /Invoke-StudioBoundedTest -NodeBinary \$runtimePath/);
  assert.match(source, /\$report\.stdout\s*=\s*\[string\]\$capture\.stdout/);
  assert.match(source, /\$report\.stderr\s*=\s*\[string\]\$capture\.stderr/);
  assert.match(guard, /\$process\.StandardOutput\.ReadAsync\(\$bufferOut/);
  assert.match(guard, /\$process\.StandardError\.ReadAsync\(\$bufferErr/);
  assert.match(guard, /test-output-limit-exceeded/);
  assert.match(guard, /\$exit\s*=\s*\$process\.ExitCode/);
  assert.doesNotMatch(source + guard, /ReadToEndAsync\s*\(/);
});

test("guest test runner reports ASCII TAP and writes only the dedicated result file", async () => {
  const source = await fs.readFile(harnessPath, "utf8");
  assert.match(source, /--test-reporter=tap/);
  assert.match(source, /\$outputRoot\s*=\s*'C:\\StudioResults'/);
  assert.match(source, /\$target\s*=\s*Join-Path \$outputRoot 'result\.json'/);
  assert.match(source, /Move-Item -LiteralPath \$temporary -Destination \$target -Force/);
});
