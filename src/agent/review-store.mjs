import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PILOT_FILES, PILOT_SEED, validatePilotContent, checkPilotProject } from "./review-fixture.mjs";

const execFileAsync = promisify(execFile);
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9-]{27,28}$/;
const PRIVATE_STATUSES = new Set(["running", "pending", "approved", "rejected", "failed"]);

export class ReviewStore {
  constructor(projectRoot) {
    this.base = path.join(path.resolve(projectRoot), ".pilot-workspace");
    this.seed = path.join(this.base, "seed-repo");
    this.worktrees = path.join(this.base, "review-worktrees");
    this.manifests = path.join(this.base, "review-manifests");
    this.readyPromise = null;
  }

  async git(where, ...args) {
    const command = ["-c", "core.hooksPath=" + os.devNull, "-c", "user.name=Local Studio Pilot",
      "-c", "user.email=pilot@localhost", "-C", where, ...args];
    const output = await execFileAsync("git", command, {
      windowsHide: true, timeout: 16000, maxBuffer: 1024 * 512,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "1" }
    });
    return output.stdout;
  }

  async ready() {
    if (!this.readyPromise) {
      this.readyPromise = this.initialize().catch(error => {
        this.readyPromise = null;
        throw error;
      });
    }
    return this.readyPromise;
  }

  async initialize() {
    await fs.mkdir(this.worktrees, { recursive: true });
    await fs.mkdir(this.manifests, { recursive: true });
    const stat = await fs.lstat(this.seed).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error("unsafe-seed-path");
    if (!stat) {
      await fs.mkdir(this.seed);
      await this.git(this.seed, "init", "-b", "main");
      for (const filename of PILOT_FILES) {
        await fs.writeFile(path.join(this.seed, filename), PILOT_SEED[filename], { flag: "wx" });
      }
      await this.git(this.seed, "add", "--", ...PILOT_FILES);
      await this.git(this.seed, "commit", "-m", "Create isolated two-file agent pilot seed");
    }
    const inside = (await this.git(this.seed, "rev-parse", "--show-toplevel")).trim();
    if (path.normalize(inside).toLowerCase() !== path.normalize(this.seed).toLowerCase()) {
      throw Error("unexpected-seed-repository");
    }
    if ((await this.git(this.seed, "status", "--porcelain")).trim()) throw Error("seed-dirty");
    const seedFiles = await this.readProject(this.seed);
    for (const file of PILOT_FILES) {
      if (seedFiles[file] !== PILOT_SEED[file]) throw Error("seed-content-drift");
    }
  }

  checkedId(id) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw Error("invalid-review-id");
    return id;
  }

  manifestPath(id) {
    return path.join(this.manifests, this.checkedId(id) + ".json");
  }

  publicReview(item) {
    const { id, branch, status, createdAt, updatedAt, checks, commit, fingerprint, failure } = item;
    return { id, branch, status, createdAt, updatedAt, checks: checks ?? null,
      commit: commit ?? null, fingerprint: fingerprint ?? null, failure: failure ?? null };
  }

  async writeManifest(item) {
    if (!PRIVATE_STATUSES.has(item.status)) throw Error("invalid-review-status");
    item.updatedAt = new Date().toISOString();
    const target = this.manifestPath(item.id);
    const tmp = target + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(tmp, JSON.stringify(item, null, 2), { flag: "wx" });
      await fs.rename(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async get(id) {
    await this.ready();
    const data = JSON.parse(await fs.readFile(this.manifestPath(id), "utf8"));
    if (data.id !== id || !PRIVATE_STATUSES.has(data.status)) throw Error("invalid-review-record");
    if (data.branch !== "studio/review-" + id) throw Error("invalid-review-branch");
    return data;
  }

  async list() {
    await this.ready();
    const names = await fs.readdir(this.manifests);
    const records = [];
    for (const name of names) {
      if (!name.endsWith(".json") || !ID_PATTERN.test(name.slice(0, -5))) continue;
      try { records.push(this.publicReview(await this.get(name.slice(0, -5)))); } catch {}
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // A separate process may still be running against the same store. Only recover
  // idle runs after an intentionally conservative threshold; never delete their worktrees.
  async recoverStaleRuns({ nowMs = Date.now(), idleMs = 15 * 60 * 1000 } = {}) {
    if (!Number.isFinite(nowMs) || !Number.isInteger(idleMs) || idleMs < 5 * 60 * 1000) {
      throw Error("invalid-recovery-window");
    }
    await this.ready();
    const names = await fs.readdir(this.manifests);
    const recovered = [];
    for (const name of names) {
      if (!name.endsWith(".json") || !ID_PATTERN.test(name.slice(0, -5))) continue;
      const id = name.slice(0, -5);
      let record;
      try { record = await this.get(id); } catch { continue; }
      if (record.status !== "running") continue;
      const last = Date.parse(record.updatedAt ?? record.createdAt);
      if (!Number.isFinite(last) || nowMs - last < idleMs) continue;
      const marked = await this.fail(id, "recovered-stale-run");
      if (marked.status === "failed") recovered.push(marked);
    }
    return recovered;
  }

  // Heartbeat while the model is responding and between tool calls.
  async heartbeat(id) {
    const item = await this.get(id);
    if (item.status !== "running") throw Error("review-no-longer-running");
    await this.writeManifest(item);
    return item.updatedAt;
  }

  worktreePath(id) {
    return path.join(this.worktrees, this.checkedId(id));
  }

  async create() {
    await this.ready();
    const id = randomUUID();
    const branch = "studio/review-" + id;
    const dir = this.worktreePath(id);
    await this.git(this.seed, "worktree", "add", "-b", branch, dir, "main");
    const item = { id, branch, status: "running", createdAt: new Date().toISOString(), updatedAt: null };
    await this.writeManifest(item);
    return this.publicReview(item);
  }

  async safeFile(root, file) {
    if (!PILOT_FILES.includes(file)) throw Error("file-not-allowlisted");
    const realRoot = await fs.realpath(root);
    if (path.normalize(realRoot).toLowerCase() !== path.normalize(root).toLowerCase()) throw Error("worktree-symlink");
    const full = path.join(realRoot, file);
    const info = await fs.lstat(full);
    if (!info.isFile() || info.isSymbolicLink()) throw Error("unsafe-project-file");
    const realFile = await fs.realpath(full);
    if (path.normalize(realFile).toLowerCase() !== path.normalize(full).toLowerCase()) throw Error("file-escapes-worktree");
    return full;
  }

  async readProject(root) {
    return Object.fromEntries(await Promise.all(PILOT_FILES.map(async file =>
      [file, await fs.readFile(await this.safeFile(root, file), "utf8")]
    )));
  }

  async inspect(id) {
    const item = await this.get(id);
    if (!["running", "pending", "approved"].includes(item.status)) throw Error("review-not-open");
    return this.readProject(this.worktreePath(id));
  }

  async write(id, file, content) {
    const item = await this.get(id);
    if (item.status !== "running") throw Error("review-not-running");
    validatePilotContent(file, content);
    const target = await this.safeFile(this.worktreePath(id), file);
    const tmp = target + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(tmp, content, { flag: "wx" });
      await fs.rename(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
    return { file, bytes: Buffer.byteLength(content) };
  }

  async checks(id) {
    const contents = await this.inspect(id);
    return checkPilotProject(contents);
  }

  async fingerprint(id) {
    const contents = await this.inspect(id);
    return createHash("sha256").update(PILOT_FILES.map(f => f + "\0" + contents[f]).join("\0")).digest("hex");
  }

  async changedPaths(id) {
    const worktree = this.worktreePath(id);
    const changes = (await this.git(worktree, "status", "--porcelain", "--untracked-files=all"))
      .split(/\r?\n/).filter(Boolean);
    // No untracked files, renames, symlinks, or any changes outside the two approved paths.
    const names = changes.map(row => {
      const type = row.slice(0, 2);
      const file = row.slice(3);
      if (!/^[ MADRCU?!]{2}$/.test(type) || type.includes("?") ||
        !PILOT_FILES.includes(file) || /[RDCAU]/.test(type)) {
        throw Error("unexpected-worktree-modification");
      }
      return file;
    });
    return [...new Set(names)];
  }

  async prepare(id) {
    const item = await this.get(id);
    if (item.status !== "running") throw Error("review-not-running");
    const checks = await this.checks(id);
    const changes = await this.changedPaths(id);
    const whitespace = await this.git(this.worktreePath(id), "diff", "--check");
    if (whitespace.trim()) throw Error("diff-check-failed");
    const ready = checks.passed && PILOT_FILES.every(file => changes.includes(file));
    const update = { ...item, status: ready ? "pending" : "failed",
      checks, changedPaths: changes, fingerprint: await this.fingerprint(id),
      failure: ready ? null : "multi-file-checks-not-passed" };
    await this.writeManifest(update);
    return this.publicReview(update);
  }

  async fail(id, reason) {
    const item = await this.get(id);
    if (!["running", "pending"].includes(item.status)) return this.publicReview(item);
    const updated = { ...item, status: "failed", failure: String(reason).slice(0, 160) };
    await this.writeManifest(updated);
    return this.publicReview(updated);
  }

  async diff(id) {
    const item = await this.get(id);
    if (item.status === "rejected") throw Error("review-was-discarded");
    if (item.status === "approved" && item.commit) {
      return this.git(this.worktreePath(id), "show", "--format=", "--no-ext-diff", "--no-color", item.commit, "--", ...PILOT_FILES);
    }
    return this.git(this.worktreePath(id), "diff", "--no-ext-diff", "--no-color", "--", ...PILOT_FILES);
  }

  async approve(id) {
    const item = await this.get(id);
    if (item.status !== "pending") throw Error("approval-not-available");
    const check = await this.checks(id);
    const names = await this.changedPaths(id);
    if (!check.passed || !PILOT_FILES.every(file => names.includes(file)) ||
      await this.fingerprint(id) !== item.fingerprint) throw Error("review-changed-since-inspection");
    const target = this.worktreePath(id);
    await this.git(target, "add", "--", ...PILOT_FILES);
    await this.git(target, "commit", "-m", "Approve isolated two-file agent demo " + id.slice(0, 8));
    const commit = (await this.git(target, "rev-parse", "HEAD")).trim();
    const updated = { ...item, status: "approved", commit };
    await this.writeManifest(updated);
    return this.publicReview(updated);
  }

  async discard(id) {
    const item = await this.get(id);
    if (!["pending", "failed", "approved"].includes(item.status)) throw Error("discard-not-available");
    await this.git(this.seed, "worktree", "remove", "--force", this.worktreePath(id));
    await this.git(this.seed, "branch", "-D", item.branch);
    const updated = { ...item, status: "rejected", commit: null };
    await this.writeManifest(updated);
    return this.publicReview(updated);
  }
}
