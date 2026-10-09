import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReviewStore } from "../src/agent/review-store.mjs";
import { runReviewAgent } from "../src/agent/review-agent.mjs";
import { PILOT_SEED, checkPilotProject, validatePilotContent } from "../src/agent/review-fixture.mjs";

const HTML = PILOT_SEED["index.html"].replace(
  "  </main>", '    <button id="start-demo" aria-label="Start demo">Start demo</button>\n  </main>'
);
const CSS = PILOT_SEED["styles.css"] +
  "#start-demo { background: #285e9f; color: white; border-radius: 8px; }\n" +
  "#start-demo:focus-visible { outline: 3px solid #fbc77e; }\n";

async function withStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-review-test-"));
  const store = new ReviewStore(root);
  try { await run(store); } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
}

async function prepareValid(store) {
  const review = await store.create();
  await store.write(review.id, "index.html", HTML);
  await store.write(review.id, "styles.css", CSS);
  return { review, prepared: await store.prepare(review.id) };
}

function toolReply(name, args = {}) {
  return new Response(JSON.stringify({ message: {
    role: "assistant", content: "",
    tool_calls: [{ function: { name, arguments: args } }]
  } }), { status: 200 });
}

test("two-file static checks require styling and accessible button", () => {
  assert.equal(checkPilotProject(PILOT_SEED).passed, false);
  assert.equal(checkPilotProject({ "index.html": HTML, "styles.css": CSS }).passed, true);
  const splitAttributes = HTML.replace('<button id="start-demo" aria-label="Start demo">Start demo</button>', '<button id="start-demo">Wrong label</button><button aria-label="Start demo">Start demo</button>');
  assert.equal(checkPilotProject({ "index.html": splitAttributes, "styles.css": CSS }).passed, false);
  assert.throws(() => validatePilotContent("other.html", HTML), /not-allowlisted/);
  assert.throws(() => validatePilotContent("index.html", HTML + "<script>alert(1)</script>"), /blocked/);
  assert.throws(() => validatePilotContent("styles.css", CSS + "@import 'x.css';"), /blocked/);
});

test("Git worktree creates separate branch, approves commit without touching main, then discards", async () => {
  await withStore(async store => {
    const { review, prepared } = await prepareValid(store);
    assert.equal(prepared.status, "pending");
    assert.equal(prepared.checks.passed, true);
    assert.deepEqual(prepared.changedPaths, undefined);
    const branchDiff = await store.diff(review.id);
    assert.match(branchDiff, /start-demo/);
    const mainOriginal = await store.readProject(store.seed);
    assert.deepEqual(mainOriginal, PILOT_SEED);
    const approved = await store.approve(review.id);
    assert.equal(approved.status, "approved");
    assert.match(approved.commit, /^[a-f0-9]{40}$/);
    assert.deepEqual(await store.readProject(store.seed), PILOT_SEED);
    assert.equal((await store.git(store.seed, "rev-parse", "main")).trim() === approved.commit, false);
    const reopened = new ReviewStore(path.dirname(store.base));
    assert.equal((await reopened.get(review.id)).status, "approved");
    const discarded = await reopened.discard(review.id);
    assert.equal(discarded.status, "rejected");
    await assert.rejects(fs.stat(store.worktreePath(review.id)), { code: "ENOENT" });
    assert.deepEqual(await store.readProject(store.seed), PILOT_SEED);
    await assert.rejects(store.approve(review.id), /approval-not-available/);
  });
});

test("discarding a pending review removes isolated worktree but not original main", async () => {
  await withStore(async store => {
    const { review, prepared } = await prepareValid(store);
    assert.equal(prepared.status, "pending");
    const declined = await store.discard(review.id);
    assert.equal(declined.status, "rejected");
    assert.deepEqual(await store.readProject(store.seed), PILOT_SEED);
    assert.doesNotMatch(await store.git(store.seed, "branch", "--list"), /studio\/review-/);
  });
});

test("changed content after review fails approval, never commits", async () => {
  await withStore(async store => {
    const { review } = await prepareValid(store);
    await fs.appendFile(path.join(store.worktreePath(review.id), "styles.css"), "/* outside change */\n");
    await assert.rejects(store.approve(review.id), /review-changed-since-inspection/);
    assert.equal((await store.get(review.id)).status, "pending");
    await store.discard(review.id);
  });
});

test("untracked file causes fail-closed review validation", async () => {
  await withStore(async store => {
    const review = await store.create();
    await store.write(review.id, "index.html", HTML);
    await store.write(review.id, "styles.css", CSS);
    await fs.writeFile(path.join(store.worktreePath(review.id), "sneaky.js"), "process.exit(1)");
    await assert.rejects(store.prepare(review.id), /unexpected-worktree-modification/);
    await store.fail(review.id, "untracked-file");
    assert.equal((await store.get(review.id)).status, "failed");
    await store.discard(review.id);
  });
});

test("review tool agent performs multi-file sequence with simulated Ollama", async () => {
  await withStore(async store => {
    const replies = [
      toolReply("inspect_project"),
      toolReply("write_file", { path: "index.html", content: HTML }),
      toolReply("write_file", { path: "styles.css", content: CSS }),
      toolReply("run_checks"),
      toolReply("finish", { summary: "Button added and styled" })
    ];
    let count = 0;
    const result = await runReviewAgent({
      store, maxSteps: 6,
      fetchImpl: async url => {
        assert.equal(url, "http://127.0.0.1:11555/api/chat");
        return replies[count++];
      }
    });
    assert.equal(result.ok, true);
    assert.equal(result.review.status, "pending");
    assert.equal(result.events.filter(x => x.kind === "tool").length, 5);
    assert.equal(count, 5);
    assert.match(result.diff, /focus-visible/);
    await store.discard(result.id);
  });
});

test("agent refuses cloud URL before any session is created", async () => {
  await withStore(async store => {
    await assert.rejects(runReviewAgent({
      store, baseUrl: "https://openrouter.ai/api/v1"
    }), /local-inference-only/);
    assert.equal((await store.list()).length, 0);
  });
});

test("model cannot finish without multi-file edits", async () => {
  await withStore(async store => {
    const result = await runReviewAgent({
      store, maxSteps: 1, fetchImpl: async () => toolReply("finish", { summary: "Not really" })
    });
    assert.equal(result.ok, false);
    assert.equal(result.review.status, "failed");
    assert.ok(result.events.some(x => x.error === "checks-not-passed"));
    await store.discard(result.id);
  });
});
