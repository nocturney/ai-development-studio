import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const trustedScript = fileURLToPath(new URL("./guest-bounded-output.windows.ps1", import.meta.url));

test("bounded Windows guest process captures success/failure and kills output floods & timeouts",
  { skip: process.platform !== "win32", timeout: 35000 },
  async () => {
    const { stdout } = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", trustedScript
    ], { timeout: 30000, windowsHide: true, maxBuffer: 12000 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.passed, true);
    assert.equal(result.positive, "passed");
    assert.equal(result.negative, "failed");
    assert.equal(result.overflowStdout, "error");
    assert.equal(result.overflowStderr, "error");
    assert.equal(result.timeout, "timeout");
    assert.equal(result.traversalRejected, true);
    assert.ok(result.stdoutCaptured <= 8000);
  }
);
