const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs, TFile, TFolder } = require('./helpers/load-ts.cjs');
const { extractHtmlDocument, saveHtmlArtifact } = loadTs('src/html/html-artifact.ts');

test('extracts HTML code without including surrounding assistant commentary', () => {
  assert.equal(extractHtmlDocument('这里是页面：\n```html\n<button>运行</button>\n```\n解释'), '<button>运行</button>');
  assert.equal(extractHtmlDocument('<!DOCTYPE html><html><body>OK</body></html>'), '<!DOCTYPE html><html><body>OK</body></html>');
  assert.equal(extractHtmlDocument('普通 Markdown 回答'), undefined);
});

test('saves generated HTML as an actual html file and never rewrites existing files', async () => {
  const entries = new Map();
  const writes = [];
  const app = { vault: {
    getAbstractFileByPath: path => entries.get(path),
    createFolder: async path => { entries.set(path, new TFolder(path)); },
    create: async (path, content) => { assert.ok(!entries.has(path)); const file = new TFile(path); entries.set(path, file); writes.push(content); return file; }
  } };
  const first = await saveHtmlArtifact(app, '<button>hello</button>');
  const second = await saveHtmlArtifact(app, '<button>hello</button>');
  assert.ok(first.path.endsWith('.html'));
  assert.notEqual(first.path, second.path);
  assert.equal(writes[0], '<button>hello</button>');
});

test('HTML extraction preserves backticks inside scripts and requires a matching closing fence', () => {
  const html = '<script>const marker = "```";</script>\n<pre>\n```\n</pre>';
  assert.equal(extractHtmlDocument('````html\n' + html + '\n````'), html);
  assert.equal(extractHtmlDocument('```html\n<script>const marker = "```";</script>\n```'), '<script>const marker = "```";</script>');
  assert.equal(extractHtmlDocument('````html\n<p>unfinished</p>\n```'), undefined);
});
