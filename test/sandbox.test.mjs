import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseSandbox, createSandboxProfile } from "../src/sandbox/windows.mjs";

test("diagnostic rejects non-Windows systems safely and never enables execution", async () => {
  const state = await diagnoseSandbox({ platform: "darwin" });
  assert.equal(state.executionEnabled, false);
  assert.equal(state.featureState, "not-windows");
  assert.equal(state.requiresRestart, false);
});

test("disabled Windows Sandbox stays fail-closed", async () => {
  const state = await diagnoseSandbox({ platform: "win32", execFileImpl: async () => ({ stdout: "Disabled\r\n" }) });
  assert.equal(state.featureState, "Disabled");
  assert.equal(state.executionEnabled, false);
  assert.equal(state.requiresRestart, true);
});

test("an enabled Windows Sandbox still cannot bypass manual VM consent or use the web execution API", async () => {
  const state = await diagnoseSandbox({ platform: "win32", execFileImpl: async () => ({ stdout: "Enabled\r\n" }) });
  assert.equal(state.featureState, "Enabled");
  assert.equal(state.executionEnabled, false);
  assert.equal(state.reason, "manual-vm-controller-gated");
});

test("feature query failure always disables execution", async () => {
  const state = await diagnoseSandbox({ platform: "win32", execFileImpl: async () => { throw Error("no access"); } });
  assert.equal(state.executionEnabled, false);
  assert.equal(state.featureState, "unknown");
});

test("sandbox config requires drive-absolute mapped directory and conservative memory bounds", () => {
  for (const unsafe of ["", "relative\\folder", "\\\\server\\share", "D:\\bad\npath", "D:\\bad<folder>"]) {
    assert.throws(() => createSandboxProfile({ readonlyInputPath: unsafe }), /invalid-sandbox-input-path/);
  }
  assert.throws(() => createSandboxProfile({ readonlyInputPath: "D:\\Pilot", memoryMB: 2048 }), /invalid-sandbox-memory/);
  assert.throws(() => createSandboxProfile({ readonlyInputPath: "D:\\Pilot", memoryMB: 32768 }), /invalid-sandbox-memory/);
  const profile = createSandboxProfile({ readonlyInputPath: "D:\\Pilot Source", memoryMB: 6144 });
  assert.match(profile, /<Networking>Disable<\/Networking>/);
  assert.match(profile, /<vGPU>Disable<\/vGPU>/);
  assert.match(profile, /<ReadOnly>true<\/ReadOnly>/);
  assert.match(profile, /<ClipboardRedirection>Disable<\/ClipboardRedirection>/);
  assert.match(profile, /<MemoryInMB>6144<\/MemoryInMB>/);
  assert.match(profile, /<HostFolder>D:\\Pilot Source<\/HostFolder>/);
});

test("standard-user WMI reports Enabled state without relying on DISM elevation", async () => {
  const commands = [];
  const state = await diagnoseSandbox({
    platform: "win32",
    execFileImpl: async (exe, args) => {
      commands.push(args[3]);
      return { stdout: "1\r\n" };
    }
  });
  assert.equal(state.featureState, "Enabled");
  assert.equal(state.executionEnabled, false);
  assert.equal(state.reason, "manual-vm-controller-gated");
  assert.equal(commands.length, 1);
  assert.match(commands[0], /Get-CimInstance/);
});

test("disabled and absent WMI feature states remain fail-closed", async () => {
  for (const [number, expected] of [["2", "Disabled"], ["3", "Absent"]]) {
    const state = await diagnoseSandbox({
      platform: "win32",
      execFileImpl: async () => ({ stdout: number })
    });
    assert.equal(state.featureState, expected);
    assert.equal(state.executionEnabled, false);
    assert.equal(state.requiresRestart, true);
  }
});

test("when WMI is inaccessible, elevated DISM fallback can still diagnose Sandbox", async () => {
  const called = [];
  const state = await diagnoseSandbox({
    platform: "win32",
    execFileImpl: async (exe, args) => {
      called.push(args[3]);
      if (called.length === 1) throw Error("CIM provider unavailable");
      return { stdout: "Enabled\n" };
    }
  });
  assert.equal(state.featureState, "Enabled");
  assert.equal(state.executionEnabled, false);
  assert.equal(called.length, 2);
  assert.match(called[1], /Get-WindowsOptionalFeature/);
});

test("unrecognized WMI and DISM output never authorizes execution", async () => {
  let count = 0;
  const result = await diagnoseSandbox({
    platform: "win32",
    execFileImpl: async () => {
      count++;
      return { stdout: "not-a-feature-state\n" };
    }
  });
  assert.equal(count, 2);
  assert.equal(result.featureState, "unknown");
  assert.equal(result.executionEnabled, false);
  assert.equal(result.reason, "feature-query-failed");
});
