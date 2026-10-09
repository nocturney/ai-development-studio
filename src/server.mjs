import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanOllama } from "./ollama.mjs";
import { PROVIDER_CATALOG } from "./providers.mjs";

const HOST = "127.0.0.1";
const PORT = 4178;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return res.end(await fs.readFile(path.join(ROOT, "index.html")));
    }
    if (req.method === "GET" && req.url === "/api/providers") {
      return json(res, 200, { cloudEnabled: false, catalog: PROVIDER_CATALOG, instances: await scanOllama() });
    }
    if (req.method === "GET" && req.url === "/api/health") {
      return json(res, 200, { name: "ai-development-studio", version: "0.0.1", cloudEnabled: false, status: "prototype" });
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
server.listen(PORT, HOST, () => {
  console.log("AI Development Studio local prototype listening on http://" + HOST + ":" + PORT);
});
