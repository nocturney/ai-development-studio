// Live local-only chat stream smoke test, requiring a separate Studio sidecar.
// No cloud inference, no code execution, no file mutations.
const root = process.env.STUDIO_TEST_URL ?? "http://127.0.0.1:4183";
const selected = {
  baseUrl: "http://127.0.0.1:11555",
  model: "qwen3.5:9b",
  messages: [{ role: "user", content: "Write exactly: STREAM_OK" }]
};
const response = await fetch(root + "/api/chat/stream", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(selected),
  signal: AbortSignal.timeout(130000)
});
if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/event-stream")) {
  throw Error("stream HTTP contract invalid: " + response.status);
}
const decoder = new TextDecoder();
let frame = "", finalText = "", started = false, finished = false, deltaFrames = 0;
for await (const chunk of response.body) {
  frame += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
  let end;
  while ((end = frame.indexOf("\n\n")) >= 0) {
    const raw = frame.slice(0, end);
    frame = frame.slice(end + 2);
    const event = raw.split("\n").find(line => line.startsWith("event: "))?.slice(7);
    const dataLine = raw.split("\n").find(line => line.startsWith("data: "))?.slice(6);
    if (!event || !dataLine) continue;
    const payload = JSON.parse(dataLine);
    if (event === "start") started = true;
    if (event === "delta") { deltaFrames++; finalText += String(payload.text); }
    if (event === "done") finished = true;
    if (event === "chat-error") throw Error("model error: " + payload.error);
  }
}
console.log(JSON.stringify({ started, finished, deltaFrames, content: finalText.slice(0, 400) }));
if (!started || !finished || deltaFrames < 1 || !finalText.includes("STREAM_OK")) {
  throw Error("live stream did not match expectations");
}
const remote = await fetch(root + "/api/chat/stream", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ...selected, baseUrl: "https://openrouter.ai/api/v1" })
});
if (remote.status !== 400) throw Error("remote provider was not refused");
console.log("LOCAL_STREAM_E2E_OK REMOTE_PROVIDER_DENIED_OK");
