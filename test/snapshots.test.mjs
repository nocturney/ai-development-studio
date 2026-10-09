import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadonlyProjectCatalog } from "../src/projects/catalog.mjs";
import { ProjectSnapshotManager } from "../src/projects/snapshots.mjs";

async function fixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-snapshot-test-"));
  const projectRoot = path.join(root, "projects");
  const one = path.join(projectRoot, "demo");
  const storageRoot = path.join(root, "studio-data");
  await fs.mkdir(path.join(one, "src"), { recursive: true });
  await fs.mkdir(storageRoot);
  await fs.writeFile(path.join(one, "index.html"), "<!doctype html><h1>Demo</h1>\n");
  await fs.writeFile(path.join(one, "src", "app.js"), "export const answer=42;\n");
  await fs.writeFile(path.join(one, ".env"), "FAKE_SECRET_DO_NOT_COPY=1\n");
  const catalog = new ReadonlyProjectCatalog(projectRoot);
  const manager = new ProjectSnapshotManager({ catalog, storageRoot });
  try { await callback({ root, one, catalog, manager, storageRoot }); }
  finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
}

test("snapshot creates an isolated clean Git repository without modifying or importing secret files", async () => {
  await fixture(async ({ one, manager, storageRoot, catalog }) => {
    const before = await fs.readFile(path.join(one, "index.html"), "utf8");
    const result = await manager.create("demo");
    assert.match(result.id, /^[0-9a-f-]{36}$/);
    assert.match(result.initialCommit, /^[0-9a-f]{40}$/);
    assert.equal(result.sourceReadOnly, true);
    assert.equal(result.fileCount, 2);
    const checkout = path.join(storageRoot, "project-snapshots", result.id, "checkout");
    assert.equal(await fs.readFile(path.join(checkout, "index.html"), "utf8"), before);
    assert.equal(await fs.readFile(path.join(checkout, "src", "app.js"), "utf8"), "export const answer=42;\n");
    await assert.rejects(fs.stat(path.join(checkout, ".env")), { code: "ENOENT" });
    assert.equal((await manager.git(checkout, "rev-parse", "main")).trim(), result.initialCommit);
    assert.equal((await manager.git(checkout, "status", "--porcelain")).trim(), "");
    assert.equal(await fs.readFile(path.join(one, "index.html"), "utf8"), before);
    await assert.rejects(fs.stat(path.join(one, ".git")), { code: "ENOENT" });
    const listed = await manager.list();
    assert.equal(listed[0].id, result.id);
    const other = new ProjectSnapshotManager({ catalog, storageRoot });
    assert.equal((await other.list())[0].initialCommit, result.initialCommit);
  });
});

test("modifying an isolated snapshot does not change original project contents", async () => {
  await fixture(async ({ one, manager, storageRoot }) => {
    const result = await manager.create("demo");
    const target = path.join(storageRoot, "project-snapshots", result.id, "checkout", "index.html");
    await fs.writeFile(target, "altered snapshot only\n");
    assert.match(await fs.readFile(path.join(one, "index.html"), "utf8"), /<!doctype html>/);
    assert.equal(await fs.readFile(target, "utf8"), "altered snapshot only\n");
  });
});

test("unknown or unsafe project selection fails without creating a snapshot", async () => {
  await fixture(async ({ manager, storageRoot }) => {
    await assert.rejects(manager.create("../private"));
    await assert.rejects(manager.create("does-not-exist"));
    assert.deepEqual(await manager.list(), []);
    const content = await fs.readdir(path.join(storageRoot, "project-snapshots")).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.equal(content.length, 0);
  });
});

test("snapshot is denied when catalog is not explicitly enabled", async () => {
  await fixture(async ({ storageRoot }) => {
    const manager = new ProjectSnapshotManager({
      catalog: new ReadonlyProjectCatalog(), storageRoot
    });
    await assert.rejects(manager.create("demo"), /catalog-not-enabled/);
  });
});

test("snapshot refuses external symlink roots instead of writing through a junction", async t => {
  await fixture(async ({ root, catalog }) => {
    const original = path.join(root, "storage-original");
    const linked = path.join(root, "storage-link");
    await fs.mkdir(original);
    try {
      await fs.symlink(original, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.diagnostic("symlinks not allowed"); return; }
      throw error;
    }
    const manager = new ProjectSnapshotManager({ catalog, storageRoot: linked });
    await assert.rejects(manager.ready(), /unsafe-snapshot-root/);
  });
});

test("tampered snapshot metadata is not exposed in snapshot history", async () => {
  await fixture(async ({ manager, storageRoot }) => {
    const snapshot = await manager.create("demo");
    const manifest = path.join(storageRoot, "project-snapshots", snapshot.id, "manifest.json");
    const data = JSON.parse(await fs.readFile(manifest, "utf8"));
    data.initialCommit = "untrusted-commit";
    await fs.writeFile(manifest, JSON.stringify(data), "utf8");
    assert.deepEqual(await manager.list(), []);
  });
});
