import test from "node:test";
import assert from "node:assert/strict";
import { windowsSandboxCliCandidates, probeWindowsVm } from "../src/sandbox/vm-controller.mjs";

const local = "C:\\Users\\Chris\\AppData\\Local";
const alias = "C:\\Users\\Chris\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe";
const system = "C:\\Windows\\System32\\wsb.exe";

test("CLI candidates prefer the Microsoft Store user alias and allow System32 fallback", () => {
  const candidates = windowsSandboxCliCandidates({ localAppData: local, systemRoot: "C:\\Windows" });
  assert.deepEqual(candidates, [alias, system]);
});

test("CLI discovery does not allow UNC, relative paths or traversal roots", () => {
  const cases = [
    { localAppData: "\\\\server\\app", systemRoot: "C:\\Windows" },
    { localAppData: ".\\here", systemRoot: "C:\\Windows" },
    { localAppData: "C:\\Users\\Chris\\..\\Admin", systemRoot: "C:\\Windows" },
    { localAppData: "C:\\bad\nname", systemRoot: "C:\\Windows" }
  ];
  for (const c of cases) {
    assert.deepEqual(windowsSandboxCliCandidates(c), [system]);
  }
  assert.deepEqual(windowsSandboxCliCandidates({
    localAppData: "C:\\Users\\Chris\\AppData\\Local",
    systemRoot: "D:\\Windows\\..\\Tmp"
  }), [alias]);
});

test("interactive readiness accepts tested Store CLI alias and never tries unrelated PATH binaries", async () => {
  const checked = [];
  const state = await probeWindowsVm({
    platform: "win32",
    username: "Chris",
    sessionProbe: async () => 1,
    featureProbe: async () => ({ featureState: "Enabled" }),
    cliCandidates: () => windowsSandboxCliCandidates({
      localAppData: local, systemRoot: "C:\\Windows"
    }),
    executableProbe: async executable => {
      checked.push(executable);
      return executable === alias;
    }
  });
  assert.equal(state.featureReady, true);
  assert.equal(state.cliPresent, true);
  assert.equal(state.executable, alias);
  assert.equal(state.executionEnabled, false);
  assert.deepEqual(checked, [alias]);
});

test("interactive readiness falls back to System32 only after unavailable alias", async () => {
  const checked = [];
  const state = await probeWindowsVm({
    platform: "win32", username: "Chris",
    sessionProbe: async () => 1,
    featureProbe: async () => ({ featureState: "Enabled" }),
    cliCandidates: () => [alias, system],
    executableProbe: async executable => {
      checked.push(executable);
      return executable === system;
    }
  });
  assert.equal(state.executable, system);
  assert.equal(state.featureReady, true);
  assert.deepEqual(checked, [alias, system]);
});

test("invalid or missing executables remain unavailable and do not allow VM execution", async () => {
  const state = await probeWindowsVm({
    platform: "win32", username: "Chris",
    sessionProbe: async () => 1,
    featureProbe: async () => ({ featureState: "Enabled" }),
    cliCandidates: () => [alias, system],
    executableProbe: async () => false
  });
  assert.equal(state.cliPresent, false);
  assert.equal(state.featureReady, false);
  assert.equal(state.executable, null);
  assert.equal(state.executionEnabled, false);
  assert.equal(state.reason, "sandbox-cli-not-installed");
});

test("noninteractive or service identity is rejected before any CLI invocation", async () => {
  let called = false;
  const state = await probeWindowsVm({
    platform: "win32", username: "NT AUTHORITY\\SYSTEM",
    featureProbe: async () => { called = true; throw Error("feature-query-not-allowed"); },
    cliCandidates: () => { called = true; return [alias]; },
    executableProbe: async () => { called = true; return true; }
  });
  assert.equal(state.reason, "interactive-user-required");
  assert.equal(called, false);
});
