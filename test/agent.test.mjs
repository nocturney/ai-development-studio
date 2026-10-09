import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PILOT_TEMPLATE, initializePilot, readPilotFile, writePilotFile, runStaticChecks } from "../src/agent/safe-workspace.mjs";
import { runPilotAgent } from "../src/agent/local-agent.mjs";

const validHtml = '<!doctype html><html><body><h1>Local AI Studio</h1><button id="start-demo" aria-label="Start demo">Start demo</button></body></html>';
const toolResponse = (name, args) => new Response(JSON.stringify({
  message: { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] }
}), { status: 200, headers: { "content-type": "application/json" } });

test("path restrictions block traversal, unrelated files, and active content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ads-safe-"));
  try {
    await initializePilot(root);
    await assert.rejects(readPilotFile(root, "../README.md"), /path-not-allowed/);
    await assert.rejects(writePilotFile(root, "../evil.html", validHtml), /path-not-allowed/);
    await assert.rejects(writePilotFile(root, "index.html", validHtml + "<script>alert(1)</script>"), /active-or-remote/);
    await assert.rejects(writePilotFile(root, "index.html", validHtml + '<img src="https://example.invalid/x">'), /active-or-remote/);
    assert.equal(await readPilotFile(root, "index.html"), PILOT_TEMPLATE);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("static checks reject missing feature and accept exact accessible button", () => {
  assert.equal(runStaticChecks(PILOT_TEMPLATE).passed, false);
  assert.equal(runStaticChecks(validHtml).passed, true);
});
test("tool-use agent performs read, write, check, finish with simulated model", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ads-flow-"));
  let turns = 0;
  const scripted = [
    toolResponse("read_file", { path: "index.html" }),
    toolResponse("write_file", { path: "index.html", content: validHtml }),
    toolResponse("run_checks", {}),
    toolResponse("finish", { summary: "Added accessible button" })
  ];
  try {
    const result = await runPilotAgent({
      workspace: root, maxSteps: 5, fetchImpl: async url => {
        assert.equal(url, "http://127.0.0.1:11555/api/chat");
        return scripted[turns++];
      }
    });
    assert.equal(result.ok, true);
    assert.equal(result.toolCount, 4);
    assert.equal(turns, 4);
    assert.equal(result.after, validHtml);
    assert.equal(result.before, PILOT_TEMPLATE);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("no remote/cloud provider can be used by pilot", async () => {
  await assert.rejects(runPilotAgent({ workspace: "unused", baseUrl: "https://openrouter.ai/api/v1" }), /local-provider-only/);
});
test("tools cannot finish before checks pass", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ads-sequence-"));
  try {
    const result = await runPilotAgent({
      workspace: root, maxSteps: 1, fetchImpl: async () => toolResponse("finish", { summary: "fake pass" })
    });
    assert.equal(result.ok, false);
    assert.equal(result.events.at(-1).error, "passing-checks-required");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
