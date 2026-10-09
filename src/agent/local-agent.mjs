import { initializePilot, readPilotFile, writePilotFile, runStaticChecks } from "./safe-workspace.mjs";

export const PILOT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file", description: "Read index.html from the isolated test workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file", description: "Replace index.html with complete updated static HTML. No JavaScript, external URLs, or other file paths allowed.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }
    }
  },
  {
    type: "function",
    function: {
      name: "run_checks", description: "Run safe static checks for required accessible button and preserved heading. Does not execute generated code.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "finish", description: "Finish after run_checks passes. Give short summary.",
      parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] }
    }
  }
];

const SYSTEM_PROMPT = `You are a coding agent operating ONLY in a tiny, isolated HTML test workspace.
Goal: Edit index.html to add an accessible <button id="start-demo" aria-label="Start demo">Start demo</button> while preserving <h1>Local AI Studio</h1>.
Use the function tools, not plain text code. Strict sequence:
1. read_file with path "index.html" to inspect current contents.
2. write_file with path "index.html" and FULL updated HTML.
3. run_checks. If tests fail, modify file again and rerun checks.
4. finish with a short summary ONLY after checks pass.
No scripts, remote URLs, shell commands, other paths, package changes or unrelated edits.
Your output is verified by the tool executor. If tool errors, use the feedback to fix the next call.`;

function enforceLocalBase(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw Error("local-provider-only");
  }
  return parsed.origin;
}

export async function runPilotAgent({
  workspace, model = "qwen3.5:9b", baseUrl = "http://127.0.0.1:11555",
  fetchImpl = fetch, maxSteps = 8, onEvent = () => {}
}) {
  const origin = enforceLocalBase(baseUrl);
  if (!/^[-.\w:]{3,100}$/.test(model)) throw Error("invalid-model");
  const root = await initializePilot(workspace);
  const before = await readPilotFile(root, "index.html");
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "Please complete the isolated test task using tools." }
  ];
  const events = [];
  let didRead = false, didWrite = false, checksPassed = false;
  let summary = null;
  function record(event) {
    const item = { at: new Date().toISOString(), ...event };
    events.push(item);
    onEvent(item);
  }

  for (let step = 1; step <= maxSteps && !summary; step++) {
    const response = await fetchImpl(origin + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(100000),
      body: JSON.stringify({
        model, messages, tools: PILOT_TOOLS, stream: false, think: false,
        options: { num_ctx: 16384, num_predict: 1250, temperature: 0.1 }
      })
    });
    if (!response.ok) throw Error("model-http-" + response.status);
    const data = await response.json();
    const assistant = data.message || {};
    const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    record({ step, kind: "inference", toolCount: toolCalls.length, contentChars: String(assistant.content || "").length });
    if (!toolCalls.length) {
      messages.push({ role: "assistant", content: assistant.content || "" });
      messages.push({ role: "user", content: "The task is not complete. Call the tools in the specified order." });
      continue;
    }

    messages.push({ role: "assistant", content: assistant.content || "", tool_calls: toolCalls });
    for (const tool of toolCalls) {
      const name = tool?.function?.name;
      let result;
      try {
        let args = tool?.function?.arguments || {};
        if (typeof args === "string") args = JSON.parse(args);
        if (!args || typeof args !== "object" || Array.isArray(args)) throw Error("invalid-arguments");
        switch (name) {
          case "read_file":
            result = { content: await readPilotFile(root, args.path) };
            didRead = true;
            break;
          case "write_file":
            if (!didRead) throw Error("read-required-first");
            result = await writePilotFile(root, args.path, args.content);
            didWrite = true;
            checksPassed = false;
            break;
          case "run_checks":
            if (!didWrite) throw Error("write-required-first");
            result = runStaticChecks(await readPilotFile(root, "index.html"));
            checksPassed = result.passed;
            break;
          case "finish":
            if (!checksPassed) throw Error("passing-checks-required");
            summary = String(args.summary || "Completed").slice(0, 300);
            result = { finished: true, summary };
            break;
          default:
            throw Error("tool-not-allowed");
        }
        record({ step, kind: "tool", tool: name, ok: true, passed: name === "run_checks" ? checksPassed : undefined });
      } catch (error) {
        result = { error: String(error.message || error) };
        record({ step, kind: "tool", tool: String(name || "unknown"), ok: false, error: result.error });
      }
      messages.push({ role: "tool", tool_name: name || "unknown", content: JSON.stringify(result) });
    }
  }

  const after = await readPilotFile(root, "index.html");
  const check = runStaticChecks(after);
  return {
    ok: Boolean(summary) && didWrite && check.passed,
    summary: summary || "Agent did not finish within the step budget",
    before, after, check, events, toolCount: events.filter(x => x.kind === "tool").length
  };
}
