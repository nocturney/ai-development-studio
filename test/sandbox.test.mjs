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

test("even an enabled Windows Sandbox cannot execute until the trusted runner is implemented", async () => {
  const state = await diagnoseSandbox({ platform: "win32", execFileImpl: async () => ({ stdout: "Enabled\r\n" }) });
  assert.equal(state.featureState, "Enabled");
  assert.equal(state.executionEnabled, false);
  assert.equal(state.reason, "runner-not-yet-implemented");
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
