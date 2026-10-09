import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_CATALOG, checkProviderAccess } from "../src/providers.mjs";
import { scanOllama } from "../src/ollama.mjs";

const get = id => PROVIDER_CATALOG.find(p => p.id === id);

test("local Ollama works with cloud off", () => {
  assert.deepEqual(checkProviderAccess(get("ollama")), { allowed: true, reason: "local" });
});
test("cloud disabled by default, including free models", () => {
  assert.equal(checkProviderAccess(get("openrouter-free")).reason, "cloud-disabled");
});
test("cloud requires provider-specific approval", () => {
  assert.equal(checkProviderAccess(get("openrouter-free"), { cloudEnabled: true }).reason, "provider-not-approved");
});
test("unconfigured remote adapter cannot be executed", () => {
  const result = checkProviderAccess(get("openrouter-free"), { cloudEnabled: true, approvedProviderIds: ["openrouter-free"] });
  assert.deepEqual(result, { allowed: false, reason: "adapter-not-ready" });
});
test("unverified community route stays blocked even with consent", () => {
  const result = checkProviderAccess(get("g4f-experimental"), {
    cloudEnabled: true, approvedProviderIds: ["g4f-experimental"]
  });
  assert.equal(result.reason, "unverified-cost-or-access");
});
test("user-funded provider needs additional approval", () => {
  const result = checkProviderAccess(get("puter-user"), {
    cloudEnabled: true, approvedProviderIds: ["puter-user"]
  });
  assert.equal(result.reason, "user-funded-not-approved");
});
test("Ollama scanner accepts only valid local Ollama responses", async () => {
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.endsWith("/api/version") ? { version: "0.40.1" } :
      { models: [{ name: "qwen3.5:9b", size: 6550825550 }] }
  });
  const scanned = await scanOllama({ ports: [11555], fetchImpl });
  assert.equal(scanned[0].models[0].id, "qwen3.5:9b");
  assert.equal(scanned[0].baseUrl, "http://127.0.0.1:11555");
});
test("offline instance does not fall back to external network", async () => {
  const called = [];
  const fetchImpl = async url => { called.push(url); throw new Error("offline"); };
  assert.deepEqual(await scanOllama({ ports: [11555], fetchImpl }), []);
  assert.deepEqual(called, ["http://127.0.0.1:11555/api/version", "http://127.0.0.1:11555/api/tags"]);
});
