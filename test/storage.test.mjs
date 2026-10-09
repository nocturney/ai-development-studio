import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReviewStore } from "../src/agent/review-store.mjs";
import { PILOT_SEED } from "../src/agent/review-fixture.mjs";

async function tempRoots(run) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "studio-storage-"));
  const source = path.join(parent, "source-app");
  const dataRoot = path.join(parent, "persistent-data");
  await fs.mkdir(source);
  try { await run({ parent, source, dataRoot }); }
  finally { await fs.rm(parent, { recursive: true, force: true, maxRetries: 4, retryDelay: 70 }); }
}

test("default storage is backward-compatible with existing project-local location", async () => {
  await tempRoots(async ({ source }) => {
    const store = new ReviewStore(source);
    assert.equal(store.storageMode, "legacy-project-local");
    assert.equal(store.base, path.join(source, ".pilot-workspace"));
    await store.ready();
    assert.deepEqual(await store.readProject(store.seed), PILOT_SEED);
  });
});

test("external data directory keeps review state across source locations and restarts", async () => {
  await tempRoots(async ({ parent, source, dataRoot }) => {
    const store = new ReviewStore(source, { dataRoot });
    assert.equal(store.storageMode, "external");
    const created = await store.create();
    const movedSource = path.join(parent, "source-v2");
    await fs.mkdir(movedSource);
    const newStore = new ReviewStore(movedSource, { dataRoot });
    const recovered = await newStore.get(created.id);
    assert.equal(recovered.status, "running");
    assert.equal(recovered.id, created.id);
    assert.equal(newStore.base, store.base);
    assert.equal(await fs.stat(path.join(source, ".pilot-workspace")).then(() => true).catch(() => false), false);
    await newStore.fail(created.id, "safe-stop");
    assert.equal((await store.get(created.id)).status, "failed");
    await newStore.discard(created.id);
    assert.equal((await store.get(created.id)).status, "rejected");
    assert.deepEqual(await store.readProject(store.seed), PILOT_SEED);
  });
});

test("external root rejects relative directories, drive root, empty paths and control characters", async () => {
  await tempRoots(async ({ source, dataRoot }) => {
    for (const unsafe of ["", "relative-path", path.parse(dataRoot).root, "abc\nxyz", "a\0b", 123]) {
      assert.throws(() => new ReviewStore(source, { dataRoot: unsafe }), /invalid-data-root/);
    }
    assert.throws(() => new ReviewStore("relative-source"), /invalid-project-root/);
  });
});

test("external data folder symlink is refused and does not mutate target directory", async (t) => {
  await tempRoots(async ({ parent, source, dataRoot }) => {
    const target = path.join(parent, "important");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "keep.txt"), "protected");
    try {
      await fs.symlink(target, dataRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.diagnostic("Symlink unavailable on host"); return; }
      throw error;
    }
    const store = new ReviewStore(source, { dataRoot });
    await assert.rejects(store.ready(), /unsafe-data-directory|data-directory-symlink/);
    assert.equal(await fs.readFile(path.join(target, "keep.txt"), "utf8"), "protected");
  });
});

test("existing foreign seed folder is refused instead of rewritten", async () => {
  await tempRoots(async ({ source, dataRoot }) => {
    await fs.mkdir(path.join(dataRoot, "seed-repo"), { recursive: true });
    await fs.writeFile(path.join(dataRoot, "seed-repo", "important.txt"), "safe");
    const store = new ReviewStore(source, { dataRoot });
    await assert.rejects(store.ready());
    assert.equal(await fs.readFile(path.join(dataRoot, "seed-repo", "important.txt"), "utf8"), "safe");
  });
});
