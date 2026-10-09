import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewStore } from "../src/agent/review-store.mjs";
import { PILOT_SEED } from "../src/agent/review-fixture.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new ReviewStore(project);
const base = "http://127.0.0.1:4178";
const seedMainBefore = (await store.git(store.seed, "rev-parse", "main")).trim();
const html = PILOT_SEED["index.html"].replace("  </main>",
  '    <button id="start-demo" aria-label="Start demo">Start demo</button>\n  </main>');
const css = PILOT_SEED["styles.css"] +
  "#start-demo { background: #2563eb; color: white; }\n" +
  "#start-demo:focus-visible { outline: 3px solid yellow; }\n";
const review = await store.create();
console.log("API_ACTION_REVIEW_ID=" + review.id);

async function postAction(action) {
  const response = await fetch(base + "/api/agent/reviews/action", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: review.id, action })
  });
  const data = await response.json();
  if (!response.ok) throw Error(action + " response " + response.status + ": " + JSON.stringify(data));
  return data.review;
}

try {
  await store.write(review.id, "index.html", html);
  await store.write(review.id, "styles.css", css);
  const ready = await store.prepare(review.id);
  if (ready.status !== "pending") throw Error("not pending");
  const approved = await postAction("approve");
  if (approved.status !== "approved" || !approved.commit) throw Error("HTTP approval failed");
  console.log("HTTP_APPROVE_OK " + approved.commit);

  const diffResponse = await fetch(base + "/api/agent/reviews/diff?id=" + review.id);
  const detail = await diffResponse.json();
  if (!diffResponse.ok || !detail.diff.includes("start-demo") || !detail.diff.includes("focus-visible")) {
    throw Error("approved diff not available");
  }
  console.log("HTTP_APPROVED_DIFF_OK");
  const declined = await postAction("discard");
  if (declined.status !== "rejected") throw Error("HTTP rollback failed");
  console.log("HTTP_DISCARD_OK");

  const forbidden = await fetch(base + "/api/agent/review-demo", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "remote", baseUrl: "https://openrouter.ai/api/v1" })
  });
  if (forbidden.status !== 400) throw Error("cloud model gate was bypassed");
  console.log("REMOTE_PROVIDER_GATE_OK");

  const seedMainAfter = (await store.git(store.seed, "rev-parse", "main")).trim();
  if (seedMainBefore !== seedMainAfter) throw Error("seed main was mutated");
  console.log("MAIN_SHA_UNCHANGED " + seedMainAfter);
  console.log("REVIEW_ACTION_API_SMOKE_OK");
} finally {
  const current = await store.get(review.id);
  if (["pending", "failed", "approved"].includes(current.status)) await store.discard(review.id);
}
