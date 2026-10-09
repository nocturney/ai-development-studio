// HTTP integration of isolated Git snapshots. Uses only an explicitly configured sample-site.
import fs from "node:fs/promises";
import path from "node:path";
const base = process.env.STUDIO_TEST_URL ?? "http://127.0.0.1:4185";
const projectRoot = process.env.STUDIO_TEST_PROJECT_ROOT ?? "D:\\Velvet\\AIStudioProjects";
const original = path.join(projectRoot, "sample-site", "index.html");
const initialText = await fs.readFile(original, "utf8");
const previousRes = await fetch(base + "/api/projects/snapshots");
const previous = await previousRes.json();
if (!previousRes.ok || !previous.enabled) throw Error("snapshots not enabled");
const response = await fetch(base + "/api/projects/snapshots", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ project: "sample-site" })
});
const created = await response.json();
if (response.status !== 201) throw Error("snapshot HTTP " + response.status + ": " + JSON.stringify(created));
const snapshot = created.snapshot;
if (!snapshot.sourceReadOnly || snapshot.fileCount < 2 ||
    !/^[0-9a-f-]{36}$/.test(snapshot.id) || !/^[a-f0-9]{40}$/.test(snapshot.initialCommit)) {
  throw Error("invalid snapshot contract");
}
const latest = await (await fetch(base + "/api/projects/snapshots")).json();
if (latest.snapshots.length !== previous.snapshots.length + 1 ||
    !latest.snapshots.some(x => x.id === snapshot.id)) throw Error("snapshot not persisted");
const forbidden = await fetch(base + "/api/projects/snapshots", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ project: "../" })
});
if (forbidden.status !== 400) throw Error("unsafe project snapshot accepted");
if ((await fs.readFile(original, "utf8")) !== initialText) throw Error("original project mutated");
await assertNotExists(path.join(projectRoot, "sample-site", ".git"));
console.log(JSON.stringify({
  snapshotId: snapshot.id, fileCount: snapshot.fileCount,
  baseline: snapshot.initialCommit.slice(0, 8),
  sourceUnchanged: true, traversalDenied: true
}));
console.log("PROJECT_SNAPSHOT_HTTP_OK");

async function assertNotExists(location) {
  try { await fs.lstat(location); throw Error("unexpected original project Git repository"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
