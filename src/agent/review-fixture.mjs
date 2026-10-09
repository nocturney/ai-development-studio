export const PILOT_FILES = Object.freeze(["index.html", "styles.css"]);

export const PILOT_SEED = Object.freeze({
  "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Local AI Studio - Worktree Pilot</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="app">
    <h1>Local AI Studio</h1>
    <p>Build privately using your own hardware.</p>
  </main>
</body>
</html>
`,
  "styles.css": `:root {
  color-scheme: dark;
  font-family: system-ui, sans-serif;
  background: #10131c;
  color: #e9eef7;
}
body { margin: 0; }
.app { max-width: 720px; margin: 14vh auto; padding: 32px; }
h1 { font-size: 2.4rem; }
p { line-height: 1.6; }
`
});

export function validatePilotContent(filename, content) {
  if (!PILOT_FILES.includes(filename)) throw Error("file-not-allowlisted");
  if (typeof content !== "string" || content.length < 20 || content.length > 16000 || content.includes("\0")) {
    throw Error("invalid-content-length");
  }
  if (filename === "index.html") {
    if (!/<!doctype html>/i.test(content) || !/<html\b/i.test(content) ||
      !/<h1\b[^>]*>\s*Local AI Studio\s*<\/h1>/i.test(content) ||
      !/<link\b[^>]*href=["']styles\.css["']/i.test(content)) {
      throw Error("required-html-structure-missing");
    }
    if (/<(?:script|iframe|object|embed|svg|base|form)\b|<meta\b[^>]*http-equiv|(?:\son[a-z]{3,})\s*=|(?:https?:|data:|javascript:|file:|\/\/)/i.test(content)) {
      throw Error("active-html-or-outbound-url-blocked");
    }
  } else if (/@import\b|url\s*\(|expression\s*\(|-moz-binding|behavior\s*:/i.test(content)) {
    throw Error("external-or-active-css-blocked");
  }
}

export function checkPilotProject(files) {
  const html = String(files?.["index.html"] ?? "");
  const css = String(files?.["styles.css"] ?? "");
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gi) ?? [];
  const targets = buttons.filter(button => /<button\b[^>]*\bid=["\x27]start-demo["\x27]/i.test(button));
  const checks = [
    { name: "doctype", pass: /<!doctype html>/i.test(html) },
    { name: "preserved-heading", pass: /<h1\b[^>]*>\s*Local AI Studio\s*<\/h1>/i.test(html) },
    { name: "linked-local-stylesheet", pass: /<link\b[^>]*href=["']styles\.css["']/i.test(html) },
    { name: "demo-button", pass: targets.length === 1 },
    { name: "button-aria", pass: targets.some(button => /\baria-label=["']Start demo["']/i.test(button)) },
    { name: "button-visible-label", pass: targets.some(button => />\s*Start demo\s*<\/button>/i.test(button)) },
    { name: "css-button-style", pass: /#start-demo\s*\{[^}]*\bbackground\s*:/i.test(css) },
    { name: "css-keyboard-focus", pass: /#start-demo:focus-visible\s*\{[^}]*\boutline\s*:/i.test(css) },
    { name: "no-active-html", pass: !/<(?:script|iframe|object|embed|svg|base|form)\b|(?:\son[a-z]{3,})\s*=|(?:https?:|data:|javascript:|file:|\/\/)/i.test(html) },
    { name: "no-external-css", pass: !/@import\b|url\s*\(|expression\s*\(|-moz-binding|behavior\s*:/i.test(css) }
  ];
  return { passed: checks.every(c => c.pass), checks };
}
