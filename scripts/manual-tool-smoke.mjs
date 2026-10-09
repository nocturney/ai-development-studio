// Manual diagnostic. Makes one request to loopback Ollama and does not execute returned calls.
const model = process.env.STUDIO_TEST_MODEL || "qwen3.5:9b";
const baseUrl = process.env.STUDIO_TEST_URL || "http://127.0.0.1:11555";
const body = {
  model, stream: false, think: false,
  options: { num_ctx: 16384, num_predict: 400, temperature: 0 },
  messages: [
    { role: "system", content: "You are testing function calling. You MUST call the echo tool exactly once. Do not speak." },
    { role: "user", content: "Call echo with text AGENT_TOOL_OK." }
  ],
  tools: [{
    type: "function",
    function: {
      name: "echo", description: "Return text back to the caller",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
    }
  }]
};
const res = await fetch(baseUrl + "/api/chat", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body), signal: AbortSignal.timeout(90000)
});
if (!res.ok) throw new Error("Ollama status " + res.status);
const data = await res.json();
const calls = data.message?.tool_calls || [];
console.log(JSON.stringify({ model, toolCalls: calls, content: data.message?.content || "", doneReason: data.done_reason }, null, 2));
if (calls.length !== 1 || calls[0].function.name !== "echo" || calls[0].function.arguments.text !== "AGENT_TOOL_OK") {
  process.exitCode = 2;
}
