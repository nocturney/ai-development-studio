import { parse } from "parse5";
import { PILOT_FILES, validatePilotContent, checkPilotProject } from "./agent/review-fixture.mjs";

export const PREVIEW_CSP = [
  "sandbox",
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "connect-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join("; ");

const ALLOWED_TAGS = new Set([
  "html", "head", "body", "meta", "title", "link",
  "main", "div", "section", "h1", "h2", "p", "button", "span", "strong", "em"
]);
const ALLOWED_ATTRIBUTES = Object.freeze({
  html: ["lang"],
  meta: ["charset", "name", "content"],
  link: ["rel", "href"],
  main: ["class"],
  div: ["class"],
  section: ["class"],
  span: ["class"],
  button: ["id", "aria-label", "type", "class"],
  h1: ["class"],
  h2: ["class"],
  p: ["class"]
});

function verifyElement(node) {
  if (!ALLOWED_TAGS.has(node.tagName) ||
      node.namespaceURI !== "http://www.w3.org/1999/xhtml") {
    throw new Error("preview-tag-rejected");
  }
  const allowed = ALLOWED_ATTRIBUTES[node.tagName] || [];
  const attributes = Object.fromEntries((node.attrs || []).map(attr => {
    if (attr.namespace || !allowed.includes(attr.name)) {
      throw new Error("preview-attribute-rejected");
    }
    return [attr.name, attr.value];
  }));
  if (Object.keys(attributes).length !== (node.attrs || []).length) {
    throw new Error("preview-duplicate-attributes");
  }
  if (node.tagName === "link" &&
      (Object.keys(attributes).length !== 2 ||
        attributes.rel !== "stylesheet" || attributes.href !== "styles.css")) {
    throw new Error("preview-link-rejected");
  }
  if (node.tagName === "meta") {
    const charset = Object.keys(attributes).length === 1 && attributes.charset?.toLowerCase() === "utf-8";
    const viewport = Object.keys(attributes).length === 2 &&
      attributes.name === "viewport" &&
      attributes.content === "width=device-width, initial-scale=1";
    if (!charset && !viewport) throw new Error("preview-meta-rejected");
  }
  if (node.tagName === "button") {
    const safe = ["start-demo", undefined].includes(attributes.id) &&
      ["Start demo", undefined].includes(attributes["aria-label"]) &&
      ["button", undefined].includes(attributes.type);
    if (!safe) throw new Error("preview-button-rejected");
  }
  if (attributes.class && !/^[a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)*$/.test(attributes.class)) {
    throw new Error("preview-class-rejected");
  }
  if (node.tagName === "html" && attributes.lang !== "en") throw new Error("preview-lang-rejected");
}

export function assertSafePreviewHtml(html) {
  if (typeof html !== "string" || html.length > 16000) throw new Error("preview-html-too-large");
  const parseErrors = [];
  const doc = parse(html, { onParseError: err => parseErrors.push(err.code) });
  if (parseErrors.length) throw new Error("preview-html-parse-error: " + parseErrors.slice(0, 2).join(","));
  let headingCount = 0, buttonCount = 0, stylesheetCount = 0;
  function walk(node) {
    if (node.nodeName === "#comment") throw new Error("preview-comments-not-allowed");
    if (node.nodeName === "#documentType" && node.name?.toLowerCase() !== "html") {
      throw new Error("preview-invalid-doctype");
    }
    if (node.tagName) {
      verifyElement(node);
      if (node.tagName === "h1") headingCount++;
      if (node.tagName === "button") buttonCount++;
      if (node.tagName === "link") stylesheetCount++;
    }
    for (const child of node.childNodes || []) walk(child);
  }
  walk(doc);
  if (headingCount !== 1 || buttonCount !== 1 || stylesheetCount !== 1) {
    throw new Error("preview-required-elements-missing");
  }
}

export function assertSafePreviewCss(css) {
  if (typeof css !== "string" || css.length > 16000) throw new Error("preview-css-too-large");
  // No HTML/style escape or CSS escape sequences. CSP blocks all resource loads regardless.
  if (/[<>\\@]/.test(css) ||
    /(?:url|image-set|expression|element|paint|var)\s*\(/i.test(css) ||
    /(?:-moz-binding|behavior)\s*:/i.test(css)) {
    throw new Error("preview-css-disallowed");
  }
}

export function buildStaticPreview(files) {
  if (!files || PILOT_FILES.some(file => typeof files[file] !== "string")) {
    throw new Error("preview-missing-files");
  }
  for (const file of PILOT_FILES) validatePilotContent(file, files[file]);
  if (!checkPilotProject(files).passed) throw new Error("preview-static-checks-failed");
  const html = files["index.html"];
  const css = files["styles.css"];
  assertSafePreviewHtml(html);
  assertSafePreviewCss(css);
  const closingHead = /<\/head\s*>/i;
  if (!closingHead.test(html)) throw new Error("preview-head-missing");
  return html.replace(closingHead, "<style>\n" + css + "\n</style>\n</head>");
}
