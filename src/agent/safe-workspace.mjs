import fs from "node:fs/promises";
import path from "node:path";

const PILOT_FILE = "index.html";
const MAX_HTML_LENGTH = 18000;
export const PILOT_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Local Pilot</title></head>
<body><main><h1>Local AI Studio</h1><p>This is an isolated test workspace.</p></main></body></html>
`;

export async function initializePilot(root) {
  await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root);
  const filename = path.join(realRoot, PILOT_FILE);
  try {
    const stats = await fs.lstat(filename);
    if (!stats.isFile() || stats.isSymbolicLink()) throw Error("unsafe-workspace-file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.writeFile(filename, PILOT_TEMPLATE, { flag: "wx" });
  }
  return realRoot;
}

export function requirePilotFile(file) {
  if (file !== PILOT_FILE) throw new Error("path-not-allowed");
  return file;
}

async function safePath(root, file) {
  requirePilotFile(file);
  const realRoot = await fs.realpath(root);
  const full = path.join(realRoot, PILOT_FILE);
  const stat = await fs.lstat(full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("unsafe-workspace-file");
  if (path.dirname(full) !== realRoot) throw Error("path-outside-workspace");
  return full;
}

export async function readPilotFile(root, file) {
  return fs.readFile(await safePath(root, file), "utf8");
}

export function validatePilotHtml(html) {
  if (typeof html !== "string" || html.length < 30 || html.length > MAX_HTML_LENGTH) {
    throw Error("invalid-html-length");
  }
  if (!/<!doctype html>/i.test(html) || !/<h1[\s>]/i.test(html)) {
    throw Error("invalid-html-structure");
  }
  if (/<script\b|<iframe\b|\son[a-z]+\s*=|https?:\/\//i.test(html)) {
    throw Error("active-or-remote-content-blocked");
  }
}

export async function writePilotFile(root, file, html) {
  const filename = await safePath(root, file);
  validatePilotHtml(html);
  await fs.writeFile(filename, html, "utf8");
  return { file, bytes: Buffer.byteLength(html, "utf8") };
}

export function runStaticChecks(html) {
  const checks = [
    { name: "doctype", pass: /<!doctype html>/i.test(html) },
    { name: "preserve-heading", pass: /<h1[^>]*>\s*Local AI Studio\s*<\/h1>/i.test(html) },
    { name: "accessible-button", pass: /<button\b[^>]*id=["']start-demo["'][^>]*>/i.test(html) &&
      /<button\b[^>]*aria-label=["']Start demo["'][^>]*>/i.test(html) },
    { name: "visible-label", pass: /Start demo\s*<\/button>/i.test(html) },
    { name: "no-active-content", pass: !/<script\b|<iframe\b|\son[a-z]+\s*=|https?:\/\//i.test(html) }
  ];
  return { passed: checks.every(c => c.pass), checks };
}
