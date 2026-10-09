import test from "node:test";
import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import { streamLocalChat, validateLocalChatSelection } from "../src/streaming/ollama-chat.mjs";

const instances = [{ baseUrl: "http://127.0.0.1:11555", models: [{ id: "qwen3.5:9b" }] }];
const request = { baseUrl: instances[0].baseUrl, model: "qwen3.5:9b",
  messages: [{ role: "user", content: "Hi" }] };
const makeResponse = (...chunks) => ({ ok: true, body: new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(Buffer.from(chunk)); controller.close(); }
}) });

test("only discovered local endpoints and models are authorized", () => {
  assert.deepEqual(validateLocalChatSelection(request, instances), request);
  assert.throws(() => validateLocalChatSelection({ ...request, baseUrl: "https://openrouter.ai/api/v1" }, instances), /local-model-not-found/);
  assert.throws(() => validateLocalChatSelection({ ...request, model: "not-installed" }, instances), /local-model-not-found/);
  assert.throws(() => validateLocalChatSelection({ ...request, messages: [] }, instances), /invalid-messages/);
});

test("NDJSON parser handles fragmented chunks and Unicode, accumulating one reply", async () => {
  const selected = validateLocalChatSelection(request, instances);
  const observed = [];
  let requestBody;
  const answer = await streamLocalChat({
    selected, onDelta: x => observed.push(x),
    fetchImpl: async (url, opts) => {
      assert.equal(url, "http://127.0.0.1:11555/api/chat");
      requestBody = JSON.parse(opts.body);
      return makeResponse('{"message":{"content":"שלום"},"done":false}\n{"mess',
        'age":{"content":" עולם"},"done":false}\n{"message":{"content":""},"done":true,"eval_count":8,"prompt_eval_count":3}\n');
    }
  });
  assert.deepEqual(observed, ["שלום", " עולם"]);
  assert.equal(answer.text, "שלום עולם");
  assert.deepEqual(answer.usage, { promptTokens: 3, outputTokens: 8 });
  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.think, false);
});

test("stream accepts last JSON frame without trailing newline", async () => {
  const selected = validateLocalChatSelection(request, instances);
  const reply = await streamLocalChat({
    selected, fetchImpl: async () => makeResponse('{"message":{"content":"ok"},"done":true}')
  });
  assert.equal(reply.text, "ok");
});

test("stream errors and early EOF do not count as completed replies", async () => {
  const selected = validateLocalChatSelection(request, instances);
  await assert.rejects(streamLocalChat({
    selected, fetchImpl: async () => makeResponse('{"message":{"content":"partial"},"done":false}\n')
  }), /ended-before-done/);
  await assert.rejects(streamLocalChat({
    selected, fetchImpl: async () => makeResponse('{"error":"model missing","done":true}\n')
  }), /ollama-model-error/);
  await assert.rejects(streamLocalChat({
    selected, fetchImpl: async () => makeResponse('{invalid}\n')
  }), /invalid-ollama-stream-json/);
});

test("client abort prevents completion and propagates cancellation upstream", async () => {
  const selected = validateLocalChatSelection(request, instances);
  const controller = new AbortController();
  let seenAbort = false;
  const mock = async (_url, options) => {
    const body = new ReadableStream({
      start(s) {
        options.signal.addEventListener("abort", () => {
          seenAbort = true;
          s.error(options.signal.reason);
        }, { once: true });
      }
    });
    return { ok: true, body };
  };
  const promise = streamLocalChat({ selected, signal: controller.signal, fetchImpl: mock });
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(promise, /cancelled/);
  assert.equal(seenAbort, true);
});

test("maliciously oversized chunk cannot exhaust unbounded memory", async () => {
  const selected = validateLocalChatSelection(request, instances);
  await assert.rejects(streamLocalChat({
    selected, fetchImpl: async () => makeResponse("x".repeat(150000))
  }), /frame-too-large/);
});
