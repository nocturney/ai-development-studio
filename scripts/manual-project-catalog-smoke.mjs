// Manual HTTP smoke for the opt-in, read-only local project catalog.
// A dedicated test root must explicitly contain the "sample-site" fixture.
const root = process.env.STUDIO_TEST_URL ?? "http://127.0.0.1:4184";
const list = await (await fetch(root + "/api/projects")).json();
if (!list.enabled || !list.projects.some(x => x.id === "sample-site")) {
  throw Error("test project not visible or feature was not explicitly enabled");
}
const filesRes = await fetch(root + "/api/projects/files?project=sample-site");
const files = await filesRes.json();
if (!filesRes.ok || !files.readOnly || !files.files.some(x => x.path === "index.html")) {
  throw Error("project file list contract failed");
}
const dataRes = await fetch(root + "/api/projects/file?project=sample-site&path=index.html");
const data = await dataRes.json();
if (!dataRes.ok || !data.readOnly || !data.content.includes("Local Studio Example")) {
  throw Error("safe project file did not render");
}
for (const url of [
  "/api/projects/files?project=..",
  "/api/projects/file?project=sample-site&path=..%2F.env",
  "/api/projects/file?project=sample-site&path=../../secrets.txt"
]) {
  const response = await fetch(root + url);
  if (response.status !== 400) throw Error("invalid path was accepted: " + url);
}
console.log(JSON.stringify({
  projects: list.projects.length, files: files.files.length,
  bytesRead: data.bytes, traversalDenied: true, readOnly: true
}));
console.log("PROJECT_CATALOG_HTTP_OK");
