const url = "http://127.0.0.1:4178/api/agent/demo";
const request = { baseUrl: "http://127.0.0.1:11555", model: "qwen3.5:9b" };
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(request),
  signal: AbortSignal.timeout(500000)
});
if (!response.ok) throw Error("Agent API returned " + response.status + " " + await response.text());
if (!response.headers.get("content-type")?.includes("text/event-stream")) {
  throw Error("Missing SSE content type");
}
const decoder = new TextDecoder();
let buffer = "", ended = false, result = null, toolEvents = [];
for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
  let offset;
  while ((offset = buffer.indexOf("\n\n")) >= 0) {
    const raw = buffer.slice(0, offset); buffer = buffer.slice(offset + 2);
    const lines = raw.split("\n");
    const event = lines.find(x => x.startsWith("event: "))?.slice(7);
    const dataText = lines.find(x => x.startsWith("data: "))?.slice(6);
    if (!event || !dataText) continue;
    const data = JSON.parse(dataText);
    if (event === "progress" && data.kind === "tool") {
      toolEvents.push({ tool: data.tool, ok: data.ok });
      console.log("TOOL " + data.tool + " " + (data.ok ? "PASS" : "FAIL"));
    } else if (event === "done") {
      result = data;
      ended = true;
      console.log("DONE ok=" + data.ok + " checks=" + data.check.checks.filter(c => c.pass).length);
    } else if (event === "agent-error") {
      throw Error("Agent API SSE error: " + data.error);
    }
  }
}
if (!ended || !result?.ok) throw Error("Agent did not complete successfully");
if (!result.diff.some(x => x.type === "add" && x.text.includes("start-demo"))) {
  throw Error("Agent diff lacked expected button addition");
}
if (toolEvents.length < 4) throw Error("Incomplete tool trace");
console.log("AGENT_SSE_INTEGRATION_OK");
