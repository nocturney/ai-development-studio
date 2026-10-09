// End-to-end static preview API verification on a temporary loopback sidecar.
// Start from the integration worktree, and run its server with STUDIO_PORT=4180.
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ReviewStore } from "../src/agent/review-store.mjs";
import { PILOT_SEED } from "../src/agent/review-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new ReviewStore(root, { dataRoot: process.env.STUDIO_DATA_ROOT });
const base = process.env.STUDIO_TEST_URL ?? "http://127.0.0.1:4180";
const sandboxResponse = await fetch(base + "/api/sandbox/diagnostic");
if (sandboxResponse.status !== 200) throw Error("Sandbox diagnostic unavailable");
const sandbox = await sandboxResponse.json();
if (sandbox.executionEnabled !== false || sandbox.boundary !== "diagnostic-only") {
  throw Error("Sandbox unexpectedly allowed generated-code execution");
}
console.log("SANDBOX_EXECUTION_DISABLED_OK");
const html = PILOT_SEED["index.html"].replace(
  "  </main>", '    <button id="start-demo" aria-label="Start demo">Start demo</button>\n  </main>'
);
const css = PILOT_SEED["styles.css"] +
  "#start-demo { background: navy; border-radius: 8px; }\n" +
  "#start-demo:focus-visible { outline: 3px solid gold; }\n";
let current = null;
const baseline = await store.git(store.seed, "rev-parse", "main").catch(async () => {
  await store.ready();
  return store.git(store.seed, "rev-parse", "main");
});
const mainSha = baseline.trim();

async function prepare() {
  const item = await store.create();
  current = item.id;
  await store.write(item.id, "index.html", html);
  await store.write(item.id, "styles.css", css);
  const pending = await store.prepare(item.id);
  if (pending.status !== "pending") throw Error("Review did not pass static checks");
  return item.id;
}

async function preview(id) {
  return fetch(base + "/api/agent/reviews/preview?id=" + encodeURIComponent(id));
}
try {
  let id = await prepare();
  let response = await preview(id);
  if (response.status !== 200) throw Error("Valid preview returned " + response.status);
  const csp = response.headers.get("content-security-policy") || "";
  const content = await response.text();
  for (const field of ["sandbox", "script-src 'none'", "connect-src 'none'", "frame-src 'none'", "frame-ancestors 'self'", "form-action 'none'"]) {
    if (!csp.includes(field)) throw Error("Missing preview CSP: " + field);
  }
  for (const field of ["#start-demo", "<style>", "Start demo"]) {
    if (!content.includes(field)) throw Error("Missing inline preview content: " + field);
  }
  if (content.includes("<script")) throw Error("Unsafe script in preview");
  console.log("PREVIEW_PENDING_OK");

  response = await preview("../../");
  if (response.status !== 409) throw Error("Traversal preview returned " + response.status);
  await fs.appendFile(path.join(store.worktreePath(id), "styles.css"), "\n/* tampered after review */\n");
  response = await preview(id);
  if (response.status !== 409) throw Error("Tampered preview was served");
  console.log("PREVIEW_TAMPER_DENIED_OK");
  await store.discard(id);
  current = null;
  response = await preview(id);
  if (response.status !== 409) throw Error("Discarded preview was served");
  console.log("PREVIEW_DISCARD_DENIED_OK");

  id = await prepare();
  const approved = await store.approve(id);
  if (!approved.commit || approved.status !== "approved") throw Error("Approval failed");
  response = await preview(id);
  if (response.status !== 200) throw Error("Approved preview returned " + response.status);
  console.log("PREVIEW_APPROVED_OK");
  await store.discard(id);
  current = null;

  const finalSha = (await store.git(store.seed, "rev-parse", "main")).trim();
  if (finalSha !== mainSha) throw Error("Pilot main changed");
  console.log("PREVIEW_API_E2E_OK");
} finally {
  if (current) {
    const record = await store.get(current);
    if (record.status === "running") await store.fail(current, "smoke-cleanup");
    await store.discard(current);
  }
}
