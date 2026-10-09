import test from "node:test";
import assert from "node:assert/strict";
import { PILOT_SEED } from "../src/agent/review-fixture.mjs";
import { PREVIEW_CSP, buildStaticPreview, assertSafePreviewCss, assertSafePreviewHtml } from "../src/preview.mjs";

const html = PILOT_SEED["index.html"].replace("  </main>",
  '    <button id="start-demo" aria-label="Start demo">Start demo</button>\n  </main>');
const css = PILOT_SEED["styles.css"] +
  "#start-demo { background: #285e9f; border-radius: 8px; }\n" +
  "#start-demo:focus-visible { outline: 3px solid #fbc77e; }\n";
const good = { "index.html": html, "styles.css": css };

test("safe generated static HTML and CSS can be shown in nonexecutable preview", () => {
  const markup = buildStaticPreview(good);
  assert.ok(markup.includes("<style>"));
  assert.ok(markup.includes("#start-demo:focus-visible"));
  assert.ok(markup.includes("</style>"));
  assert.ok(markup.includes('aria-label="Start demo"'));
  assert.ok(PREVIEW_CSP.includes("sandbox"));
  assert.ok(PREVIEW_CSP.includes("default-src 'none'"));
  assert.ok(PREVIEW_CSP.includes("script-src 'none'"));
  assert.ok(PREVIEW_CSP.includes("connect-src 'none'"));
});

test("HTML parser rejects executable, embedded and unknown tags", () => {
  for (const injection of [
    '<script>alert("x")</script>',
    '<svg onload="alert(1)"></svg>',
    '<iframe src="https://example.invalid"></iframe>',
    '<img src="data:image/svg+xml,evil">',
    '<form action="/post"><input></form>',
    '<object data="file:///etc/passwd"></object>',
    '<!-- a hidden comment -->'
  ]) {
    const injected = html.replace("  </main>", "    " + injection + "\n  </main>");
    assert.throws(() => assertSafePreviewHtml(injected), /preview-/);
  }
});

test("HTML parser rejects extraneous attributes and external stylesheet links", () => {
  assert.throws(() => assertSafePreviewHtml(html.replace("<main", '<main onclick="evil()"')), /preview-attribute/);
  assert.throws(() => assertSafePreviewHtml(html.replace('href="styles.css"', 'href="https://evil.invalid"')), /preview-link/);
  assert.throws(() => assertSafePreviewHtml(html.replace('name="viewport"', 'http-equiv="refresh"')), /preview-/);
});

test("CSS injection and all network-capable resource references are rejected", () => {
  for (const rule of [
    '@import "https://evil.invalid/x.css";',
    '#start-demo{background: url(https://evil.invalid/x.png)}',
    '#start-demo{background: image-set("x.png" 1x)}',
    '</style><script>alert(1)</script>',
    '\\75rl(https://evil.invalid/pixel)',
    '#start-demo{behavior: url(x.htc)}'
  ]) {
    assert.throws(() => assertSafePreviewCss(css + rule), /preview-css-disallowed/);
  }
});

test("preview requires verified two-file structural checks", () => {
  assert.throws(() => buildStaticPreview(PILOT_SEED), /static-checks-failed/);
  assert.throws(() => buildStaticPreview({ ...good, "styles.css": css.replace("focus-visible", "focus") }), /static-checks-failed/);
  assert.throws(() => buildStaticPreview({ ...good, "index.html": html.replace("<h1>Local AI Studio</h1>", "<h1>Other</h1>") }), /required-html/);
});
