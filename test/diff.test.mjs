import test from "node:test";
import assert from "node:assert/strict";
import { diffLines } from "../src/agent/diff.mjs";

test("line diff captures modifications and shared context", () => {
  assert.deepEqual(diffLines("A\nB\n", "A\nC\n"), [
    { type: "context", text: "  A" },
    { type: "remove", text: "- B" },
    { type: "add", text: "+ C" }
  ]);
});
test("identical text has no addition or removal", () => {
  assert.ok(diffLines("A\nB", "A\nB").every(row => row.type === "context"));
});
