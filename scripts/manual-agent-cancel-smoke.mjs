// Smoke-test the cancellation HTTP/SSE contract on a *separate* local server.
// Start src/server.mjs with STUDIO_PORT=4179 before running this script.
const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:4179";
const model = "qwen3.5:9b";
const client = await fetch(base + "/api/agent/review-demo", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model, baseUrl: "http://127.0.0.1:11555" }),
  signal: AbortSignal.timeout(55000)
});
if (!client.ok) throw Error("start-status-" + client.status);
const reader = client.body.getReader();
const decoder = new TextDecoder();
let chunkText = "";
let token;
while (!token) {
  const { done, value } = await reader.read();
  if (done) throw Error("stream-finished-before-token");
  chunkText += decoder.decode(value, { stream: true });
  const match = chunkText.match(/event: start\ndata: ([^\n]+)\n\n/);
  if (match) token = JSON.parse(match[1]).runId;
  if (chunkText.length > 200000) throw Error("unexpected-stream-size");
}
if (!/^[0-9a-f-]{36}$/.test(token)) throw Error("invalid-run-token");
const wrong = await fetch(base + "/api/agent/review-demo/cancel", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ runId: "00000000-0000-0000-0000-000000000000" })
});
if (wrong.status !== 409) throw Error("wrong-token-was-not-blocked");
const cancelled = await fetch(base + "/api/agent/review-demo/cancel", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ runId: token })
});
if (cancelled.status !== 202 || !(await cancelled.json()).cancellationRequested) {
  throw Error("cancellation-was-not-accepted");
}
console.log("CANCEL_REQUEST_ACCEPTED");
let doneStream = chunkText;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  doneStream += decoder.decode(value, { stream: true });
  if (doneStream.length > 500000) throw Error("unexpectedly-large-stream");
}
if (!doneStream.includes("agent-cancelled")) {
  throw Error("SSE did not report an agent cancellation");
}
const recent = await (await fetch(base + "/api/agent/reviews")).json();
const failed = recent.reviews.find(x => x.failure === "cancelled-by-user");
if (!failed || failed.status !== "failed") {
  throw Error("cancelled review was not durably marked failed");
}
const status = await (await fetch(base + "/api/agent/review-demo/status")).json();
if (status.running) throw Error("runner did not release busy flag");
console.log("CANCELLED_REVIEW_ID=" + failed.id);
console.log("CANCELLED_REVIEW_NOT_APPROVABLE=true");
console.log("AGENT_CANCEL_SSE_OK");
