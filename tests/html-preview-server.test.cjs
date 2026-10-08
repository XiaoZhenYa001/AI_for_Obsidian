const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { loadTs } = require('./helpers/load-ts.cjs');
const { startHtmlPreviewServer } = loadTs('src/html/html-preview-server.ts');

function request(server, path, options = {}) {
  const url = new URL(server.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: url.port, path, method: options.method || 'GET', headers: { host: url.host, ...options.headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
}
async function fixture(t) {
  const source = '<!doctype html>\n<base href="./"><iframe src="child.html"></iframe><script type="module" src="app.js"></script>';
  const files = new Map([['site/index.html', source], ['site/app.js', 'export const value = 42;'], ['site/data.json', '{"ok":true}'], ['site/media/video.mp4', '0123456789']]);
  const reads = [];
  const server = await startHtmlPreviewServer({ filePath: 'site/index.html', allowNetwork: false, readFile: async path => { reads.push(path); const data = files.get(path); return data === undefined ? undefined : { data }; } });
  t.after(() => server.close());
  return { server, source, reads };
}

test('full preview preserves HTML bytes and serves modules and data with browser MIME types', async t => {
  const { server, source, reads } = await fixture(t);
  assert.match(server.origin, /^http:\/\/[a-f0-9]{32}\.localhost:\d+$/);
  const document = await request(server, '/index.html');
  assert.equal(document.body, source);
  assert.match(document.headers['content-type'], /^text\/html/);
  assert.equal((await request(server, '/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await request(server, '/data.json?x=1')).body, '{"ok":true}');
  assert.ok(reads.every(path => path.startsWith('site/')));
  assert.equal(document.headers['referrer-policy'], 'no-referrer');
  assert.equal(document.headers['x-content-type-options'], 'nosniff');
});

test('full preview rejects other hosts, directory traversal, hidden files, notes and service workers before reading', async t => {
  const { server, reads } = await fixture(t);
  for (const path of ['/', '/../private.html', '/%2e%2e/private.html', '/%2fetc/passwd', '/.obsidian/a.json', '/nested/%5csecret.js', '/notes.md', '/bad%00.js', '//elsewhere/app.js']) {
    assert.equal((await request(server, path)).status, 403, path);
  }
  assert.equal((await request(server, '/index.html', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await request(server, '/app.js', { headers: { 'service-worker': 'script' } })).status, 403);
  assert.equal((await request(server, '/index.html', { method: 'POST' })).status, 405);
  assert.deepEqual(reads, []);
});

test('network CSP changes for both pages and worker scripts while local resources remain supported', async t => {
  const { server } = await fixture(t);
  const offline = (await request(server, '/app.js')).headers['content-security-policy'];
  assert.match(offline, /connect-src 'self' blob: data:/);
  assert.doesNotMatch(offline, /https:/);
  server.setAllowNetwork(true);
  assert.match((await request(server, '/app.js')).headers['content-security-policy'], /https: http:/);
  server.setAllowNetwork(false);
  assert.equal((await request(server, '/index.html')).headers['content-security-policy'], offline);
});

test('media byte ranges, HEAD and repeated shutdown work without exposing unrelated files', async t => {
  const { server } = await fixture(t);
  const range = await request(server, '/media/video.mp4', { headers: { range: 'bytes=2-5' } });
  assert.equal(range.status, 206); assert.equal(range.body, '2345');
  assert.equal(range.headers['content-range'], 'bytes 2-5/10');
  assert.equal((await request(server, '/media/video.mp4', { method: 'HEAD' })).body, '');
  assert.equal((await request(server, '/media/video.mp4', { headers: { range: 'bytes=99-' } })).status, 416);
  assert.equal((await request(server, '/missing.js')).status, 404);
  await server.close(); await server.close();
  await assert.rejects(request(server, '/index.html'));
});
