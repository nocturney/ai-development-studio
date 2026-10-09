const url = "http://127.0.0.1:4178";
const response = await fetch(url + "/api/agent/review-demo", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ baseUrl: "http://127.0.0.1:11555", model: "qwen3.5:9b" }),
  signal: AbortSignal.timeout(420000)
});
if (!response.ok) throw Error("Agent SSE HTTP " + response.status + ": " + await response.text());
if (!response.headers.get("content-type")?.includes("text/event-stream")) throw Error("Missing SSE response");
const decoder = new TextDecoder();
let buffer = "", result = null, toolNames = [];
for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let end;
  while ((end = buffer.indexOf("\n\n")) >= 0) {
    const raw = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    const lines = raw.split("\n");
    const event = lines.find(x => x.startsWith("event: "))?.slice(7);
    const payload = lines.find(x => x.startsWith("data: "))?.slice(6);
    if (!event || !payload) continue;
    const data = JSON.parse(payload);
    if (event === "progress" && data.kind === "tool") {
      console.log(data.tool + " " + (data.ok ? "PASS" : "REJECTED"));
      toolNames.push(data.tool);
    } else if (event === "done") {
      result = data;
      console.log("REVIEW_ID=" + data.review.id + " STATUS=" + data.review.status);
    } else if (event === "agent-error") {
      throw Error("SSE agent error: " + data.error);
    }
  }
}
if (!result?.ok || result.review.status !== "pending" ||
  !result.checks?.passed || toolNames.length < 5 ||
  !result.diff.includes("start-demo") || !result.diff.includes("focus-visible")) {
  throw Error("Agent API smoke failed verification");
}
console.log("LIVE_TWO_FILE_AGENT_SSE_OK checks=" + result.checks.checks.length);
console.log("Pending review retained for explicit approval in the local UI.");
