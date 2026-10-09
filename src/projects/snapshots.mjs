import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ReadonlyProjectCatalog } from "./catalog.mjs";

const execFileAsync = promisify(execFile);
const SNAPSHOT_SCHEMA = "studio.project-snapshot.v1";
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,28}$/;

export class ProjectSnapshotManager {
  constructor({ catalog, storageRoot }) {
    if (!(catalog instanceof ReadonlyProjectCatalog)) throw Error("trusted-project-catalog-required");
    if (typeof storageRoot !== "string" || !path.isAbsolute(storageRoot) ||
      path.resolve(storageRoot) === path.parse(storageRoot).root) throw Error("invalid-snapshot-root");
    this.catalog = catalog;
    this.root = path.join(path.resolve(storageRoot), "project-snapshots");
  }

  async ready() {
    await fs.mkdir(this.root, { recursive: true });
    const info = await fs.lstat(this.root);
    const real = await fs.realpath(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() ||
      path.normalize(real).toLowerCase() !== path.normalize(this.root).toLowerCase()) {
      throw Error("unsafe-snapshot-root");
    }
  }

  async git(repo, ...args) {
    const config = [
      "-c", "core.hooksPath=" + os.devNull,
      "-c", "user.name=Studio Snapshot",
      "-c", "user.email=snapshot@localhost",
      "-c", "core.fsmonitor=false",
      "-C", repo, ...args
    ];
    const result = await execFileAsync("git", config, {
      windowsHide: true, timeout: 18000, maxBuffer: 512 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    return String(result.stdout);
  }

  async list() {
    const current = await fs.lstat(this.root).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!current) return [];
    if (!current.isDirectory() || current.isSymbolicLink() ||
        (await fs.realpath(this.root)).toLowerCase() !== path.resolve(this.root).toLowerCase()) {
      throw Error("unsafe-snapshot-root");
    }
    const names = await fs.readdir(this.root);
    const results = [];
    for (const id of names.slice(0, 250)) {
      if (!ID_PATTERN.test(id)) continue;
      try {
        const folder = path.join(this.root, id);
        const info = await fs.lstat(folder);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const real = await fs.realpath(folder);
        if (path.normalize(real).toLowerCase() !== path.normalize(folder).toLowerCase()) continue;
        const manifestPath = path.join(folder, "manifest.json");
        const manifestStat = await fs.lstat(manifestPath);
        if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 256000) continue;
        const raw = await fs.readFile(manifestPath, "utf8");
        const data = JSON.parse(raw);
        if (data.schema !== SNAPSHOT_SCHEMA || data.id !== id ||
          typeof data.project !== "string" || typeof data.createdAt !== "string" ||
          !/^[a-f0-9]{40}$/.test(data.initialCommit) ||
          !Number.isInteger(data.bytes) || data.bytes < 1 || data.bytes > 8*1024*1024 ||
          !Number.isInteger(data.fileCount) || data.fileCount < 1 || data.fileCount > 200) continue;
        results.push({
          id: data.id, project: data.project,
          fileCount: data.fileCount, bytes: data.bytes,
          createdAt: data.createdAt, initialCommit: data.initialCommit,
          sourceReadOnly: true, snapshotEditableLater: true
        });
      } catch {}
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(projectName) {
    if (!this.catalog.enabled) throw Error("project-catalog-not-enabled");
    const files = await this.catalog.listFiles(projectName);
    if (files.files.length < 1 || files.files.length > 200) {
      throw Error("invalid-snapshot-file-count");
    }
    await this.ready();
    const already = await this.list();
    if (already.length >= 25) throw Error("snapshot-capacity-reached");
    const totalDeclared = files.files.reduce((sum, file) => sum + file.bytes, 0);
    if (totalDeclared > 8 * 1024 * 1024) throw Error("snapshot-too-large");
    const id = randomUUID();
    const home = path.join(this.root, id);
    const checkout = path.join(home, "checkout");
    await fs.mkdir(home);
    await fs.mkdir(checkout);
    try {
      const entries = [];
      let bytesTotal = 0;
      for (const file of files.files) {
        const result = await this.catalog.readText(projectName, file.path);
        const bytes = Buffer.byteLength(result.content, "utf8");
        bytesTotal += bytes;
        if (bytesTotal > 8 * 1024 * 1024) throw Error("snapshot-too-large");
        const dest = path.join(checkout, ...file.path.split("/"));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, result.content, { flag: "wx" });
        entries.push({
          path: file.path, bytes,
          sha256: createHash("sha256").update(result.content).digest("hex")
        });
      }
      await this.git(checkout, "init", "-b", "main");
      await this.git(checkout, "add", "--all");
      await this.git(checkout, "commit", "-m", "Import isolated read-only project snapshot " + id.slice(0, 8));
      const initialCommit = (await this.git(checkout, "rev-parse", "HEAD")).trim();
      if (!/^[a-f0-9]{40}$/.test(initialCommit)) throw Error("invalid-initial-commit");
      if ((await this.git(checkout, "status", "--porcelain")).trim()) throw Error("snapshot-working-tree-not-clean");
      const manifest = {
        schema: SNAPSHOT_SCHEMA, id, project: projectName,
        createdAt: new Date().toISOString(),
        fileCount: entries.length, bytes: bytesTotal, initialCommit,
        files: entries, sourceReadOnly: true
      };
      await fs.writeFile(path.join(home, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
      return {
        id, project: projectName, fileCount: entries.length,
        bytes: bytesTotal, createdAt: manifest.createdAt, initialCommit,
        sourceReadOnly: true, snapshotEditableLater: true
      };
    } catch (error) {
      await fs.rm(home, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}
