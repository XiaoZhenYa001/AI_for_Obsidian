const assert = require("node:assert/strict");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");
const { resolveVaultResourcePath, htmlPreviewCsp, rewriteCssResources, HTML_PREVIEW_SANDBOX } = loadTs("src/html/html-document.ts");

test("vault resources resolve relative to each referencing HTML or CSS document", () => {
  assert.equal(resolveVaultResourcePath("pages/demo.html", "../assets/image%20one.png?v=2#icon"), "assets/image one.png");
  assert.equal(resolveVaultResourcePath("assets/styles/main.css", "../fonts/demo.woff2"), "assets/fonts/demo.woff2");
  assert.equal(resolveVaultResourcePath("pages/demo.html", "/shared/theme.css"), "shared/theme.css");
  assert.equal(resolveVaultResourcePath("pages/demo.html", ".\\js\\main.js"), "pages/js/main.js");
});

test("resource resolution rejects URLs, hidden vault metadata and traversal outside the vault", () => {
  for (const reference of [
    "../../secret.png", "%2e%2e/%2e%2e/secret.png", "../.obsidian/config.json",
    "../.git/config", "file:///etc/passwd", "C:\\secret.png", "https://example.com/a.png",
    "//example.com/a.png", "\\\\example.com\\a.png", "data:image/png;base64,a", "javascript:alert(1)",
    "%00image.png", "%zz.png", "#section"
  ]) assert.equal(resolveVaultResourcePath("pages/demo.html", reference), undefined, reference);
});

test("the preview allows scripts without granting same-origin, popups or host privileges", () => {
  assert.equal(HTML_PREVIEW_SANDBOX, "allow-scripts");
  const policy = htmlPreviewCsp();
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'unsafe-inline' data: blob:/);
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, /frame-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /form-action 'none'/);
  assert.doesNotMatch(policy, /https?:|file:|app:|'self'|'unsafe-eval'/);
});

test("online resource loading is opt-in and leaves sandbox navigation restrictions intact", () => {
  const policy = htmlPreviewCsp(true);
  assert.match(policy, /connect-src https: http: wss: ws:/);
  assert.match(policy, /script-src 'unsafe-inline' data: blob: https: http:/);
  assert.match(policy, /frame-src 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /form-action 'none'/);
});

test("CSS rewriting preserves media rules and resolves quoted and unquoted local URLs", async () => {
  const seen = [];
  const css = '@import "theme.css" screen; @import url(\'print.css\') print; .hero { background:url(../image.png); mask:url("icons.svg#mark"); }';
  const output = await rewriteCssResources(css, async (reference) => {
    seen.push(reference);
    return `data:text/plain,${encodeURIComponent(reference)}`;
  });
  assert.deepEqual(seen, ["theme.css", "print.css", "../image.png", "icons.svg#mark"]);
  assert.match(output, /@import "data:text\/plain,theme.css" screen/);
  assert.match(output, /@import url\("data:text\/plain,print.css"\) print/);
  assert.match(output, /background:url\("data:text\/plain,..%2Fimage.png"\)/);
  assert.match(output, /mask:url\("data:text\/plain,icons.svg%23mark"\)/);
});
