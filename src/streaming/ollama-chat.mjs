const MAX_LINE_LENGTH = 65536;
const MAX_OUTPUT_CHARS = 80000;

export function validateLocalChatSelection(input, instances) {
  if (!input || typeof input !== "object") throw Error("invalid-chat-selection");
  const server = instances.find(x => x.baseUrl === input.baseUrl);
  if (!server || !server.models.some(model => model.id === input.model)) {
    throw Error("local-model-not-found");
  }
  const address = new URL(server.baseUrl);
  if (address.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(address.hostname)) {
    throw Error("untrusted-model-address");
  }
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 14 ||
      !input.messages.every(m => m && ["user", "assistant"].includes(m.role) &&
        typeof m.content === "string" && m.content.length > 0 && m.content.length <= 7000)) {
    throw Error("invalid-messages");
  }
  return { baseUrl: server.baseUrl, model: input.model,
    messages: input.messages.map(m => ({ role: m.role, content: m.content })) };
}

export async function streamLocalChat({
  selected, fetchImpl = fetch, signal = AbortSignal.timeout(120000),
  onDelta = () => {}, onDone = () => {}
}) {
  const timeout = AbortSignal.timeout(120000);
  const finalSignal = AbortSignal.any([signal, timeout]);
  const response = await fetchImpl(selected.baseUrl + "/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    signal: finalSignal,
    body: JSON.stringify({
      model: selected.model, messages: selected.messages, stream: true,
      think: false, options: { num_ctx: 8192, num_predict: 768 }
    })
  });
  if (!response.ok || !response.body) throw Error("ollama-stream-unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let completed = false;
  let output = "";
  let usage = null;
  const parseLine = line => {
    if (!line.trim()) return;
    let value;
    try { value = JSON.parse(line); } catch { throw Error("invalid-ollama-stream-json"); }
    if (!value || typeof value !== "object") throw Error("invalid-ollama-stream-frame");
    if (value.error) throw Error("ollama-model-error");
    const delta = value.message?.content ?? "";
    if (typeof delta !== "string") throw Error("invalid-ollama-stream-delta");
    if (delta.length > 0) {
      if (output.length + delta.length > MAX_OUTPUT_CHARS) throw Error("ollama-output-too-large");
      output += delta;
      onDelta(delta);
    }
    if (value.done === true) {
      completed = true;
      usage = {
        promptTokens: Number.isFinite(value.prompt_eval_count) ? value.prompt_eval_count : null,
        outputTokens: Number.isFinite(value.eval_count) ? value.eval_count : null
      };
    }
  };
  try {
    while (true) {
      finalSignal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_LINE_LENGTH * 2) throw Error("ollama-stream-frame-too-large");
      let offset;
      while ((offset = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, offset).trim();
        buffer = buffer.slice(offset + 1);
        if (line.length > MAX_LINE_LENGTH) throw Error("ollama-stream-frame-too-large");
        parseLine(line);
        if (completed) break;
      }
      if (completed) break;
    }
    if (!completed && buffer.trim()) parseLine(buffer.trim());
    finalSignal.throwIfAborted();
    if (!completed) throw Error("ollama-stream-ended-before-done");
    onDone({ text: output, usage });
    return { text: output, usage };
  } finally {
    // Cancel upstream to release resources when the browser aborts.
    await reader.cancel().catch(() => {});
  }
}
