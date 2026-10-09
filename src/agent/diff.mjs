export function diffLines(before, after) {
  const left = String(before).replace(/\r\n/g, "\n").trimEnd().split("\n");
  const right = String(after).replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (left.length * right.length > 50000) {
    return [
      { type: "info", text: "Diff too large for the prototype. Showing before and after snapshots." },
      { type: "remove", text: left.slice(0, 300).join("\n") },
      { type: "add", text: right.slice(0, 300).join("\n") }
    ];
  }
  const n = left.length, m = right.length;
  const counts = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      counts[i][j] = left[i] === right[j] ? 1 + counts[i + 1][j + 1] : Math.max(counts[i + 1][j], counts[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      rows.push({ type: "context", text: "  " + left[i++] }); j++;
    } else if (counts[i + 1][j] >= counts[i][j + 1]) {
      rows.push({ type: "remove", text: "- " + left[i++] });
    } else {
      rows.push({ type: "add", text: "+ " + right[j++] });
    }
  }
  while (i < n) rows.push({ type: "remove", text: "- " + left[i++] });
  while (j < m) rows.push({ type: "add", text: "+ " + right[j++] });
  return rows;
}
