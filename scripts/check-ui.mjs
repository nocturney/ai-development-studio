import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const filename = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html");
const html = await fs.readFile(filename, "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw Error("missing UI script");
new vm.Script(match[1], { filename: "public/index.html" });
if (!["agentDemo", "agentDiff", "reviewDemo", "cancelReview", "approveReview", "discardReview", "previewPanel", "previewFrame", "sandboxStatus", "storageStatus", "stopChat"].every(id => html.includes('id="' + id + '"'))) {
  throw Error("agent demo controls missing");
}
if (!html.includes('"/api/agent/review-demo/cancel"')) throw Error("cancel endpoint not wired to UI");
console.log("UI script syntax and required demo controls OK");
