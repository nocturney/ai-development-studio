import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReviewStore } from "../src/agent/review-store.mjs";
import { runReviewAgent } from "../src/agent/review-agent.mjs";
import { PILOT_SEED } from "../src/agent/review-fixture.mjs";

async function fixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-studio-recovery-"));
  const store = new ReviewStore(root);
  try { await callback(store); }
  finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 }); }
}

function normalizeLines(files) {
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [name, content.replace(/\r\n/g, "\n")]));
}

async function makeStale(store, id, oldAt) {
  const file = store.manifestPath(id);
  const contents = JSON.parse(await fs.readFile(file, "utf8"));
  contents.updatedAt = new Date(oldAt).toISOString();
  await fs.writeFile(file, JSON.stringify(contents));
}

test("stale running reviews transition to failed; files preserved until explicit discard", async () => {
  await fixture(async store => {
    const session = await store.create();
    const old = Date.now() - 22 * 60 * 1000;
    await makeStale(store, session.id, old);
    const before = (await store.git(store.seed, "rev-parse", "main")).trim();
    const recovered = await store.recoverStaleRuns({ nowMs: Date.now() });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, session.id);
    assert.equal(recovered[0].status, "failed");
    assert.equal(recovered[0].failure, "recovered-stale-run");
    assert.deepEqual(normalizeLines(await store.readProject(store.worktreePath(session.id))), PILOT_SEED);
    assert.equal((await store.git(store.seed, "rev-parse", "main")).trim(), before);
    assert.deepEqual(await store.recoverStaleRuns(), []);
    assert.equal((await store.discard(session.id)).status, "rejected");
  });
});

test("recent running and existing pending/approved reviews are never recovered", async () => {
  await fixture(async store => {
    const recent = await store.create();
    const failed = await store.create();
    await makeStale(store, failed.id, Date.now() - 20 * 60 * 1000);
    await store.fail(failed.id, "expected-failure");

    const validHtml = PILOT_SEED["index.html"].replace(
      "  </main>", '    <button id="start-demo" aria-label="Start demo">Start demo</button>\n  </main>'
    );
    const validCss = PILOT_SEED["styles.css"] +
      "#start-demo { background: navy; }\n#start-demo:focus-visible { outline: 3px solid white; }\n";
    const prepared = [];
    for (let i = 0; i < 2; i++) {
      const item = await store.create();
      await store.write(item.id, "index.html", validHtml);
      await store.write(item.id, "styles.css", validCss);
      const pending = await store.prepare(item.id);
      assert.equal(pending.status, "pending");
      if (i === 1) await store.approve(item.id);
      prepared.push(item.id);
      await makeStale(store, item.id, Date.now() - 28 * 60 * 1000);
    }

    assert.deepEqual(await store.recoverStaleRuns(), []);
    assert.equal((await store.get(recent.id)).status, "running");
    assert.equal((await store.get(prepared[0])).status, "pending");
    assert.equal((await store.get(prepared[1])).status, "approved");
    await store.fail(recent.id, "cleanup");
    for (const id of [recent.id, failed.id, ...prepared]) await store.discard(id);
  });
});

test("heartbeat refreshes idle threshold and keeps active worktrees safe", async () => {
  await fixture(async store => {
    const review = await store.create();
    await makeStale(store, review.id, Date.now() - 24 * 60 * 1000);
    await store.heartbeat(review.id);
    const recovered = await store.recoverStaleRuns();
    assert.equal(recovered.length, 0);
    assert.equal((await store.get(review.id)).status, "running");
    await store.fail(review.id, "cleanup");
    await store.discard(review.id);
  });
});

test("reject dangerously short or invalid stale recovery windows", async () => {
  await fixture(async store => {
    await assert.rejects(store.recoverStaleRuns({ idleMs: 1000 }), /invalid-recovery-window/);
    await assert.rejects(store.recoverStaleRuns({ nowMs: NaN }), /invalid-recovery-window/);
  });
});

test("user abort prevents all model tool execution and records failed review", async () => {
  await fixture(async store => {
    const controller = new AbortController();
    let reviewId;
    let calls = 0;
    await assert.rejects(runReviewAgent({
      store, signal: controller.signal,
      onEvent: event => {
        if (event.kind === "review-created") {
          reviewId = event.id;
          controller.abort(new DOMException("user-cancelled", "AbortError"));
        }
      },
      fetchImpl: async () => { calls++; throw Error("unexpected-inference"); }
    }), /user-cancelled/);
    assert.equal(calls, 0);
    const review = await store.get(reviewId);
    assert.equal(review.status, "failed");
    assert.equal(review.failure, "cancelled-by-user");
    assert.deepEqual(normalizeLines(await store.readProject(store.worktreePath(reviewId))), PILOT_SEED);
    await store.discard(reviewId);
  });
});

test("agent-wide deadline cancels pending inference and leaves no approvable review", async () => {
  await fixture(async store => {
    let reviewId;
    const start = Date.now();
    const inference = async (_, options) => new Promise((_, reject) => {
      const onAbort = () => reject(options.signal.reason);
      if (options.signal.aborted) return onAbort();
      options.signal.addEventListener("abort", onAbort, { once: true });
    });
    await assert.rejects(runReviewAgent({
      store, maxRunMs: 1000,
      onEvent: event => { if (event.kind === "review-created") reviewId = event.id; },
      fetchImpl: inference
    }), /timeout|Timeout|Abort/i);
    const review = await store.get(reviewId);
    assert.equal(review.status, "failed");
    assert.equal(review.failure, "agent-deadline-exceeded");
    assert.ok(Date.now() - start < 5000);
    await assert.rejects(store.approve(reviewId), /approval-not-available/);
    await store.discard(reviewId);
  });
});

test("cancellation after partial edits never prepares or approves changes", async () => {
  await fixture(async store => {
    const controller = new AbortController();
    const html = PILOT_SEED["index.html"].replace(
      "  </main>", '    <button id="start-demo" aria-label="Start demo">Start demo</button>\n  </main>'
    );
    const css = PILOT_SEED["styles.css"] +
      "#start-demo { background: navy; }\n" +
      "#start-demo:focus-visible { outline: 2px solid white; }\n";
    const scripted = [
      { name: "inspect_project", args: {} },
      { name: "write_file", args: { path: "index.html", content: html } },
      { name: "write_file", args: { path: "styles.css", content: css } },
      { name: "run_checks", args: {} },
      { name: "finish", args: { summary: "should never occur" } }
    ];
    let index = 0;
    let reviewId;
    await store.ready();
    const mainBefore = (await store.git(store.seed, "rev-parse", "main")).trim();
    await assert.rejects(runReviewAgent({
      store, signal: controller.signal,
      onEvent: event => {
        if (event.kind === "review-created") reviewId = event.id;
        if (event.kind === "tool" && event.tool === "write_file" && event.ok &&
            index === 3) controller.abort(new DOMException("cancel-mid-run", "AbortError"));
      },
      fetchImpl: async () => {
        const call = scripted[index++];
        return new Response(JSON.stringify({ message: {
          role: "assistant", content: "",
          tool_calls: [{ function: { name: call.name, arguments: call.args } }]
        } }));
      }
    }), /cancel-mid-run/);
    assert.equal(index, 3);
    const failed = await store.get(reviewId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure, "cancelled-by-user");
    assert.match((await store.readProject(store.worktreePath(reviewId)))["index.html"], /start-demo/);
    assert.equal((await store.git(store.seed, "rev-parse", "main")).trim(), mainBefore);
    await assert.rejects(store.approve(reviewId), /approval-not-available/);
    await store.discard(reviewId);
  });
});
