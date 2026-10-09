import fs from "node:fs/promises";
import path from "node:path";

const ALLOWED_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".html", ".css", ".json", ".md", ".txt", ".yaml", ".yml"
]);
const BLOCKED_BASENAMES = new Set([
  ".env", ".git", ".svn", ".hg", "node_modules", ".ssh",
  "secrets", "credentials", "private", "dist", "build", "vendor"
]);

function validateSegment(segment) {
  if (typeof segment !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(segment) ||
      segment === "." || segment === ".." || segment.startsWith(".") ||
      BLOCKED_BASENAMES.has(segment.toLowerCase())) {
    throw Error("project-name-not-allowed");
  }
  return segment;
}

function validateRelative(rel) {
  if (typeof rel !== "string" || !rel.length || rel.length > 180 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(rel) ||
      rel.includes("\\") || rel.includes("//")) throw Error("invalid-project-file-path");
  const parts = rel.split("/");
  for (const part of parts) {
    validateSegment(part);
  }
  if (!ALLOWED_EXTENSIONS.has(path.posix.extname(rel).toLowerCase())) {
    throw Error("unsupported-project-file");
  }
  return parts;
}

async function safeDirectory(dir) {
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error("unsafe-project-directory");
  const real = await fs.realpath(dir);
  if (path.normalize(real).toLowerCase() !== path.normalize(dir).toLowerCase()) {
    throw Error("unsafe-project-directory");
  }
  return dir;
}

async function safeFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("unsafe-project-file");
  const real = await fs.realpath(file);
  if (path.normalize(real).toLowerCase() !== path.normalize(file).toLowerCase()) {
    throw Error("unsafe-project-file");
  }
  return stat;
}

export class ReadonlyProjectCatalog {
  constructor(root = null) {
    if (root !== null && (typeof root !== "string" ||
      !path.isAbsolute(root) || path.parse(root).root === path.resolve(root))) {
      throw Error("invalid-project-catalog-root");
    }
    this.root = root === null ? null : path.resolve(root);
  }

  get enabled() { return this.root !== null; }

  async ready() {
    if (!this.enabled) throw Error("project-catalog-not-enabled");
    await safeDirectory(this.root);
  }

  async list() {
    if (!this.enabled) return { enabled: false, projects: [] };
    await this.ready();
    const found = [];
    const children = await fs.readdir(this.root, { withFileTypes: true });
    for (const child of children.slice(0, 400)) {
      try {
        validateSegment(child.name);
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
        await safeDirectory(path.join(this.root, child.name));
        found.push({ id: child.name, name: child.name });
      } catch {
        // Symlink/junction, hidden and reserved directories never appear in UI.
      }
      if (found.length >= 100) break;
    }
    return { enabled: true, projects: found.sort((a, b) => a.id.localeCompare(b.id)) };
  }

  async projectRoot(projectName) {
    await this.ready();
    const name = validateSegment(projectName);
    const target = path.join(this.root, name);
    await safeDirectory(target);
    if (path.dirname(target).toLowerCase() !== this.root.toLowerCase()) throw Error("project-outside-allowed-root");
    return target;
  }

  async listFiles(projectName) {
    const root = await this.projectRoot(projectName);
    const found = [];
    const queue = [{ dir: root, relative: "", depth: 0 }];
    while (queue.length && found.length < 240) {
      const { dir, relative, depth } = queue.shift();
      let contents = await fs.readdir(dir, { withFileTypes: true });
      contents = contents.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of contents) {
        if (found.length >= 240) break;
        try {
          validateSegment(entry.name);
          if (entry.isSymbolicLink()) continue;
          const next = path.join(dir, entry.name);
          const name = relative ? relative + "/" + entry.name : entry.name;
          if (entry.isDirectory() && depth < 3) {
            await safeDirectory(next);
            queue.push({ dir: next, relative: name, depth: depth + 1 });
          } else if (entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase())) {
            const stat = await safeFile(next);
            if (stat.size >= 1 && stat.size <= 256 * 1024) {
              found.push({ path: name, bytes: stat.size });
            }
          }
        } catch {
          // Files outside the allowlist remain invisible, even if encountered.
        }
      }
    }
    return { project: projectName, readOnly: true, files: found };
  }

  async readText(projectName, relativePath) {
    const root = await this.projectRoot(projectName);
    const parts = validateRelative(relativePath);
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      dir = path.join(dir, part);
      await safeDirectory(dir);
    }
    const file = path.join(dir, parts.at(-1));
    const stat = await safeFile(file);
    if (stat.size < 1 || stat.size > 256 * 1024) throw Error("project-file-too-large");
    const bytes = await fs.readFile(file);
    if (bytes.includes(0)) throw Error("binary-project-file");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { project: projectName, path: relativePath, readOnly: true, bytes: stat.size, content };
  }
}
