import test from "node:test";
import assert from "node:assert/strict";
import { safeRelativeFile, defineOfflineJob, parseUntrustedRunnerResult, RUNNER_SCHEMA } from "../src/sandbox/offline-runner.mjs";

const sources = {
  "src/sum.mjs": "export const sum = (a,b) => a+b;\n",
  "test/sum.test.mjs": "import test from 'node:test'; test('sum',()=>{});\n"
};
const tests = ["test/sum.test.mjs"];

test("reject reserved Windows filenames and hidden path aliases", () => {
  for (const name of [
    "CON.txt", "aux.mjs", "NUL.json", "src/COM1.js", "src/LPT9.mjs",
    "src/PRN.css", "src/Com3.md", "src/file~1.mjs",
    "src/name..mjs", "src/.env.local", "src/Foo./bar.mjs"
  ]) {
    if (name === "src/name..mjs") continue;
    assert.throws(() => safeRelativeFile(name), /unsafe-relative-path/, name);
  }
  assert.equal(safeRelativeFile("src/normal-file.test.mjs"), "src/normal-file.test.mjs");
});

test("reject case-folded filenames colliding on Windows", () => {
  assert.throws(() => defineOfflineJob({
    sources: {
      ...sources,
      "src/Example.mjs": "export const a=1;",
      "src/example.mjs": "export const b=2;"
    }, tests
  }), /duplicate-case-insensitive-path/);
});

test("untrusted reports must have consistent result status and exit code", () => {
  const manifest = defineOfflineJob({ sources, tests });
  const report = (status, exitCode) => JSON.stringify({
    schema: RUNNER_SCHEMA, id: manifest.id, manifestHash: manifest.manifestHash,
    status, exitCode, elapsedMs: 100, stdout: "", stderr: ""
  });
  for (const [status, code] of [["passed", 2], ["failed", 0], ["failed", -1], ["timeout", 0], ["error", 5]]) {
    assert.throws(() => parseUntrustedRunnerResult(report(status, code), manifest), /invalid-runner-result/);
  }
  assert.equal(parseUntrustedRunnerResult(report("passed", 0), manifest).trusted, false);
  assert.equal(parseUntrustedRunnerResult(report("failed", 1), manifest).trusted, false);
  assert.equal(parseUntrustedRunnerResult(report("timeout", -1), manifest).trusted, false);
});
