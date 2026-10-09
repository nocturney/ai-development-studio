import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewStore } from "../src/agent/review-store.mjs";
import { runReviewAgent } from "../src/agent/review-agent.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new ReviewStore(root, { dataRoot: process.env.STUDIO_DATA_ROOT });
console.log("Pilot: two files, isolated Git worktree, no shell execution, local-only model");
console.log("Starting main SHA:", (await store.git(root, "rev-parse", "main")).trim());
const result = await runReviewAgent({
  store, maxSteps: 12,
  onEvent: event => console.log(JSON.stringify(event))
});
console.log(JSON.stringify({
  ok: result.ok, id: result.id, status: result.review.status,
  checks: result.checks, summary: result.summary,
  changedLines: result.diff.split("\n").filter(line => /^[+-]/.test(line) && !/^[+-]{3}/.test(line)).length,
  changedFiles: (result.diff.match(/^diff --git /gm) || []).length
}, null, 2));
console.log("Ending main SHA:", (await store.git(root, "rev-parse", "main")).trim());
console.log("Review remains uncommitted until explicit approval.");
if (!result.ok) process.exitCode = 2;
