import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadonlyProjectCatalog } from "../src/projects/catalog.mjs";

async function withCatalog(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-project-catalog-"));
  const projectsRoot = path.join(root, "projects");
  const site = path.join(projectsRoot, "sample-site");
  await fs.mkdir(path.join(site, "src"), { recursive: true });
  await fs.writeFile(path.join(site, "index.html"), "<!doctype html><h1>Hello</h1>\n");
  await fs.writeFile(path.join(site, "src", "app.js"), "export const greet=()=>\"Hi\";\n");
  await fs.writeFile(path.join(site, ".env"), "EXAMPLE_SECRET=blocked");
  await fs.mkdir(path.join(site, "node_modules"));
  await fs.writeFile(path.join(site, "node_modules", "deps.js"), "hidden");
  await fs.mkdir(path.join(projectsRoot, ".private"));
  await fs.writeFile(path.join(projectsRoot, ".private", "bad.js"), "hidden");
  const catalog = new ReadonlyProjectCatalog(projectsRoot);
  try { await fn({ catalog, root, site, projectsRoot }); }
  finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 }); }
}

test("project catalog is disabled unless an explicit root is configured", async () => {
  const catalog = new ReadonlyProjectCatalog();
  assert.deepEqual(await catalog.list(), { enabled: false, projects: [] });
  await assert.rejects(catalog.readText("x", "index.html"), /not-enabled/);
  assert.throws(() => new ReadonlyProjectCatalog("relative"), /invalid-project-catalog-root/);
  assert.throws(() => new ReadonlyProjectCatalog(path.parse(os.tmpdir()).root), /invalid-project-catalog-root/);
});

test("lists permitted project folders and only safe code file metadata", async () => {
  await withCatalog(async ({ catalog }) => {
    const projects = await catalog.list();
    assert.equal(projects.enabled, true);
    assert.deepEqual(projects.projects.map(x => x.id), ["sample-site"]);
    const files = await catalog.listFiles("sample-site");
    assert.equal(files.readOnly, true);
    assert.deepEqual(files.files.map(x => x.path).sort(), ["index.html", "src/app.js"]);
    assert.equal(JSON.stringify(files).includes("EXAMPLE_SECRET"), false);
  });
});

test("reads selected text files only; excludes secrets, binaries and traversal", async () => {
  await withCatalog(async ({ catalog, site }) => {
    const result = await catalog.readText("sample-site", "src/app.js");
    assert.equal(result.readOnly, true);
    assert.match(result.content, /export const greet/);
    for (const file of [".env", "node_modules/deps.js", "../index.html", "src\\app.js", "src/../../index.html", "README.exe"]) {
      await assert.rejects(catalog.readText("sample-site", file));
    }
    await fs.writeFile(path.join(site, "blob.txt"), Buffer.from([0, 1, 2]));
    await assert.rejects(catalog.readText("sample-site", "blob.txt"), /binary-project-file/);
    await fs.writeFile(path.join(site, "big.txt"), "x".repeat(270000));
    await assert.rejects(catalog.readText("sample-site", "big.txt"), /project-file-too-large/);
  });
});

test("rejects project and file symlinks and never follows junctions outside root", async (t) => {
  await withCatalog(async ({ catalog, projectsRoot, site, root }) => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secrets.md"), "outside!");
    try {
      await fs.symlink(outside, path.join(projectsRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.diagnostic("symlinks unavailable"); return; }
      throw error;
    }
    const projectList = await catalog.list();
    assert.deepEqual(projectList.projects.map(x => x.id), ["sample-site"]);
    await assert.rejects(catalog.listFiles("linked"), /unsafe-project-directory/);
    try {
      await fs.symlink(path.join(outside, "secrets.md"), path.join(site, "secret.md"), "file");
      await assert.rejects(catalog.readText("sample-site", "secret.md"), /unsafe-project-file/);
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    }
  });
});

test("source catalog requests never alter any original project file", async () => {
  await withCatalog(async ({ catalog, site }) => {
    const before = await fs.readFile(path.join(site, "index.html"), "utf8");
    await catalog.list();
    await catalog.listFiles("sample-site");
    await catalog.readText("sample-site", "index.html");
    const after = await fs.readFile(path.join(site, "index.html"), "utf8");
    assert.equal(before, after);
  });
});
