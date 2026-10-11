import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanOllama } from "./ollama.mjs";
import { PROVIDER_CATALOG } from "./providers.mjs";
import { randomUUID } from "node:crypto";
import { runPilotAgent } from "./agent/local-agent.mjs";
import { diffLines } from "./agent/diff.mjs";
import { ReviewStore } from "./agent/review-store.mjs";
import { runReviewAgent } from "./agent/review-agent.mjs";
import { PREVIEW_CSP, buildStaticPreview } from "./preview.mjs";
import { diagnoseSandbox } from "./sandbox/windows.mjs";
import { probeWindowsVm } from "./sandbox/vm-controller.mjs";
import { validateLocalChatSelection, streamLocalChat } from "./streaming/ollama-chat.mjs";
import { ReadonlyProjectCatalog } from "./projects/catalog.mjs";
import { ProjectSnapshotManager } from "./projects/snapshots.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.STUDIO_PORT ?? 4178);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw Error("invalid-studio-port");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const PROJECT_ROOT = path.resolve(ROOT, "..");
const reviewStore = new ReviewStore(PROJECT_ROOT, { dataRoot: process.env.STUDIO_DATA_ROOT });
const projectCatalog = new ReadonlyProjectCatalog(process.env.STUDIO_PROJECTS_ROOT ?? null);
const snapshotManager = new ProjectSnapshotManager({ catalog: projectCatalog, storageRoot: reviewStore.base });
let snapshotBusy = false;
let agentActive = false;
let reviewActionActive = false;
let activeReviewRun = null;
let chatStreamActive = false;

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(data));
}
function secure(req, res) {
  if (![HOST + ":" + PORT, "localhost:" + PORT].includes(req.headers.host)) {
    json(res, 403, { error: "untrusted-host" }); return false;
  }
  if (req.headers.origin && req.headers.origin !== "http://" + req.headers.host) {
    json(res, 403, { error: "untrusted-origin" }); return false;
  }
  return true;
}
async function bodyJson(req) {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new Error("application/json required");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 24000) throw new Error("request too large");
  }
  return JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  if (!secure(req, res)) return;
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      });
      return res.end(await fs.readFile(path.join(ROOT, "index.html")));
    }
    if (req.method === "GET" && req.url === "/api/projects") {
      return json(res, 200, await projectCatalog.list());
    }
    if (req.method === "GET" && req.url === "/api/projects/snapshots") {
      if (!projectCatalog.enabled) return json(res, 200, { enabled: false, snapshots: [] });
      return json(res, 200, { enabled: true, snapshots: await snapshotManager.list() });
    }
    if (req.method === "POST" && req.url === "/api/projects/snapshots") {
      const input = await bodyJson(req);
      if (!projectCatalog.enabled || typeof input?.project !== "string") {
        return json(res, 400, { error: "snapshot-project-not-configured" });
      }
      if (snapshotBusy) return json(res, 409, { error: "snapshot-creation-busy" });
      snapshotBusy = true;
      try {
        const snapshot = await snapshotManager.create(input.project);
        return json(res, 201, { snapshot });
      } catch {
        return json(res, 400, { error: "snapshot-creation-failed" });
      } finally {
        snapshotBusy = false;
      }
    }
    if (req.method === "GET" && req.url.startsWith("/api/projects/files?")) {
      try {
        const query = new URL(req.url, "http://localhost");
        return json(res, 200, await projectCatalog.listFiles(query.searchParams.get("project")));
      } catch {
        return json(res, 400, { error: "project-not-readable" });
      }
    }
    if (req.method === "GET" && req.url.startsWith("/api/projects/file?")) {
      try {
        const query = new URL(req.url, "http://localhost");
        const data = await projectCatalog.readText(
          query.searchParams.get("project"), query.searchParams.get("path")
        );
        return json(res, 200, data);
      } catch {
        return json(res, 400, { error: "project-file-not-readable" });
      }
    }
    if (req.method === "GET" && req.url === "/api/providers") {
      return json(res, 200, { cloudEnabled: false, catalog: PROVIDER_CATALOG, instances: await scanOllama() });
    }
    if (req.method === "GET" && req.url === "/api/health") {
      return json(res, 200, { name: "ai-development-studio", version: "0.0.14", cloudEnabled: false, status: "prototype", storageMode: reviewStore.storageMode });
    }
    if (req.method === "GET" && req.url === "/api/sandbox/diagnostic") {
      const [state, controller] = await Promise.all([diagnoseSandbox(), probeWindowsVm()]);
      return json(res, 200, {
        ...state,
        executionEnabled: false,
        boundary: "diagnostic-only",
        vmController: {
          session: controller.session,
          readyForManualApproval: controller.featureReady,
          reason: controller.reason,
          launchViaWeb: false
        },
        caution: "Git worktrees are not OS execution sandboxes"
      });
    }
    if (req.method === "GET" && req.url === "/api/agent/reviews") {
      const reviews = await reviewStore.list();
      return json(res, 200, { reviews });
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/reviews/diff?")) {
      const id = new URL(req.url, "http://127.0.0.1").searchParams.get("id");
      try {
        const review = await reviewStore.get(id);
        return json(res, 200, { review: reviewStore.publicReview(review), diff: await reviewStore.diff(id) });
      } catch {
        return json(res, 404, { error: "review-not-available" });
      }
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/reviews/preview?")) {
      const id = new URL(req.url, "http://127.0.0.1").searchParams.get("id");
      try {
        const item = await reviewStore.get(id);
        if (!["pending", "approved"].includes(item.status)) {
          return json(res, 409, { error: "preview-requires-valid-review" });
        }
        if (!item.fingerprint || await reviewStore.fingerprint(id) !== item.fingerprint) {
          return json(res, 409, { error: "preview-review-content-changed" });
        }
        const html = buildStaticPreview(await reviewStore.inspect(id));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": PREVIEW_CSP,
          "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cross-Origin-Resource-Policy": "same-origin"
        });
        return res.end(html);
      } catch {
        return json(res, 409, { error: "preview-invalid-or-unavailable" });
      }
    }
    if (req.method === "POST" && req.url === "/api/agent/reviews/action") {
      const input = await bodyJson(req);
      if (agentActive || reviewActionActive) return json(res, 409, { error: "review-action-busy" });
      if (!input || !["approve", "discard"].includes(input.action)) {
        return json(res, 400, { error: "invalid-review-action" });
      }
      reviewActionActive = true;
      try {
        const review = input.action === "approve" ?
          await reviewStore.approve(input.id) : await reviewStore.discard(input.id);
        return json(res, 200, { review });
      } catch {
        return json(res, 409, { error: "review-action-not-available-or-changed" });
      } finally {
        reviewActionActive = false;
      }
    }
    if (req.method === "POST" && req.url === "/api/agent/review-demo/cancel") {
      const input = await bodyJson(req);
      if (!input || typeof input.runId !== "string" ||
          !activeReviewRun || input.runId !== activeReviewRun.runId) {
        return json(res, 409, { error: "review-run-not-active" });
      }
      activeReviewRun.controller.abort(new DOMException("cancelled-by-user", "AbortError"));
      return json(res, 202, { cancellationRequested: true });
    }
    if (req.method === "GET" && req.url === "/api/agent/review-demo/status") {
      return json(res, 200, { running: Boolean(activeReviewRun) });
    }
    if (req.method === "POST" && req.url === "/api/agent/review-demo") {
      const input = await bodyJson(req);
      if (typeof input.model !== "string" || typeof input.baseUrl !== "string") {
        return json(res, 400, { error: "invalid-model-selection" });
      }
      const instances = await scanOllama();
      if (!instances.some(instance => instance.baseUrl === input.baseUrl &&
          instance.models.some(model => model.id === input.model))) {
        return json(res, 400, { error: "local-model-not-found" });
      }
      if (agentActive) return json(res, 409, { error: "agent-currently-running" });
      agentActive = true;
      const abort = new AbortController();
      const runId = randomUUID();
      activeReviewRun = { runId, controller: abort };
      res.on("close", () => abort.abort());
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store", Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff"
      });
      const emit = (type, data) => {
        if (!res.destroyed && !res.writableEnded) {
          res.write("event: " + type + "\n" + "data: " + JSON.stringify(data) + "\n\n");
        }
      };
      emit("start", { kind: "two-file-git-worktree", model: input.model, runId });
      try {
        const result = await runReviewAgent({
          store: reviewStore, model: input.model, baseUrl: input.baseUrl,
          maxSteps: 12, signal: abort.signal, onEvent: event => emit("progress", event)
        });
        emit("done", {
          ok: result.ok, review: result.review, summary: result.summary,
          checks: result.checks, diff: result.diff
        });
      } catch {
        emit("agent-error", { error: abort.signal.aborted ? "agent-cancelled" : "agent-execution-failed" });
      } finally {
        agentActive = false;
        if (activeReviewRun?.runId === runId) activeReviewRun = null;
        res.end();
      }
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/demo") {
      const input = await bodyJson(req);
      if (typeof input.model !== "string" || typeof input.baseUrl !== "string") {
        return json(res, 400, { error: "invalid-agent-request" });
      }
      const instances = await scanOllama();
      const instance = instances.find(x => x.baseUrl === input.baseUrl && x.models.some(m => m.id === input.model));
      if (!instance) return json(res, 400, { error: "local-model-not-found" });
      if (agentActive) return json(res, 409, { error: "agent-busy" });
      agentActive = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store", "Connection": "keep-alive",
        "X-Content-Type-Options": "nosniff"
      });
      const emit = (type, data) => {
        if (!res.writableEnded && !res.destroyed) res.write("event: " + type + "\n" + "data: " + JSON.stringify(data) + "\n\n");
      };
      emit("start", { kind: "static-html-pilot", model: input.model });
      try {
        const workspace = path.join(PROJECT_ROOT, ".pilot-workspace", "browser-" + Date.now() + "-" + randomUUID().slice(0, 8));
        const result = await runPilotAgent({
          workspace, model: input.model, baseUrl: input.baseUrl,
          maxSteps: 7, onEvent: event => emit("progress", event)
        });
        emit("done", {
          ok: result.ok, summary: result.summary, check: result.check,
          diff: diffLines(result.before, result.after), events: result.events
        });
      } catch (error) {
        emit("agent-error", { error: error?.name === "TimeoutError" ? "model-timeout" : "agent-failed" });
      } finally {
        agentActive = false;
        res.end();
      }
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat/stream") {
      const input = await bodyJson(req);
      let selected;
      try {
        selected = validateLocalChatSelection(input, await scanOllama());
      } catch (error) {
        return json(res, 400, { error: String(error?.message ?? "invalid-chat-request") });
      }
      if (chatStreamActive || agentActive) return json(res, 409, { error: "local-inference-busy" });
      chatStreamActive = true;
      const abort = new AbortController();
      res.on("close", () => abort.abort(new DOMException("browser-disconnected", "AbortError")));
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store", Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff"
      });
      const emit = (event, data) => {
        if (!res.destroyed && !res.writableEnded) {
          res.write("event: " + event + "\n" + "data: " + JSON.stringify(data) + "\n\n");
        }
      };
      emit("start", { provider: "ollama", model: selected.model });
      try {
        await streamLocalChat({
          selected, signal: abort.signal,
          onDelta: delta => emit("delta", { text: delta }),
          onDone: result => emit("done", { model: selected.model, usage: result.usage })
        });
      } catch (error) {
        const reason = abort.signal.aborted ? "chat-cancelled" :
          error?.name === "TimeoutError" ? "chat-timeout" :
          ["ollama-stream-unavailable", "ollama-stream-ended-before-done",
           "invalid-ollama-stream-json", "ollama-model-error",
           "invalid-ollama-stream-frame", "ollama-stream-frame-too-large",
           "ollama-output-too-large"].includes(error?.message) ?
          error.message : "local-stream-failed";
        emit("chat-error", { error: reason });
      } finally {
        chatStreamActive = false;
        res.end();
      }
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      const input = await bodyJson(req);
      const instances = await scanOllama();
      const instance = instances.find(x => x.baseUrl === input.baseUrl);
      if (!instance || !instance.models.some(x => x.id === input.model)) {
        return json(res, 400, { error: "local-model-not-found" });
      }
      const messages = Array.isArray(input.messages) ? input.messages : [];
      if (!messages.length || messages.length > 14 ||
        !messages.every(m => ["user","assistant"].includes(m.role) && typeof m.content === "string" && m.content.length <= 7000)) {
        return json(res, 400, { error: "invalid-messages" });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90000);
      let upstream;
      try {
        upstream = await fetch(instance.baseUrl + "/api/chat", {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: input.model, messages, stream: false, think: false, options: { num_ctx: 8192, num_predict: 384 } })
        });
        if (!upstream.ok) return json(res, 502, { error: "ollama-error", status: upstream.status });
        const response = await upstream.json();
        return json(res, 200, { provider: "ollama", model: input.model, content: response.message?.content ?? "" });
      } finally { clearTimeout(timer); }
    }
    json(res, 404, { error: "not-found" });
  } catch (error) {
    json(res, 500, { error: String(error?.name === "AbortError" ? "inference-timeout" : "operation-failed") });
  }
});
try {
  const stale = await reviewStore.recoverStaleRuns();
  if (stale.length) console.warn("Recovered " + stale.length + " stale agent review(s).");
} catch (error) {
  console.warn("Agent review recovery unavailable:", String(error?.message ?? error));
}
server.listen(PORT, HOST, () => {
  console.log("AI Development Studio local prototype listening on http://" + HOST + ":" + PORT);
});
