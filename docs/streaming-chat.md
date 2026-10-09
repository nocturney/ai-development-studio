# Local-first streaming chat — v0.0.7

The primary chat pane sends authenticated same-origin requests to `POST /api/chat/stream`. The server accepts only models discovered at loopback Ollama instances. Remote URLs cannot be selected even if supplied manually.

The server relays Ollama's JSON-line stream into same-origin SSE events: `start`, `delta`, `done` and `chat-error`. The browser renders deltas through `textContent`, never as HTML.

A **Stop** button aborts the browser request and its Ollama upstream signal. An incomplete or cancelled response is shown visibly but is NOT appended to the completed assistant-message history. The protocol limits input messages, output characters and stream frame sizes; failures do not trigger cloud fallback.

## Verification

- Six stream unit tests validate discovered-model gating, Unicode fragmented NDJSON, last-frame handling, early EOF, upstream cancellation and oversized frame rejection.
- `node scripts/manual-stream-smoke.mjs` checks a real streamed local Qwen 3.5 9B answer and rejects an external provider endpoint (HTTP 400). The test requires a local Studio server at port 4183 unless `STUDIO_TEST_URL` is set.
- Streaming chat is separate from the two-file agent's tool-call protocol. The existing legacy `/api/chat` endpoint is retained for compatibility, but the UI uses the streaming route.

The model's hardware/context remains a limit, but no application message/day quota is imposed.
