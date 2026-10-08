const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');
const { HtmlSourceSession } = loadTs('src/html/html-source-session.ts');

test('source edits save atomically and preserve typing during an in-flight save', async () => {
  const session = new HtmlSourceSession();
  session.load('original'); session.text = 'saved';
  let release;
  const saving = session.save(async update => { const next = update('original'); await new Promise(r => release = r); return next; });
  session.text = 'new typing'; release(); await saving;
  assert.equal(session.base, 'saved'); assert.equal(session.text, 'new typing'); assert.equal(session.dirty, true);
});

test('external changes and stale recovered drafts cannot overwrite disk', async () => {
  const session = new HtmlSourceSession();
  session.load('original'); session.text = 'draft'; session.receive('external');
  assert.equal(session.text, 'draft'); assert.equal(session.conflict, true);
  await assert.rejects(session.save(async update => update('external')), /未覆盖/);
  const restored = new HtmlSourceSession();
  restored.load('external', { base: session.base, text: session.text });
  assert.equal(restored.conflict, true); assert.equal(restored.text, 'draft');
  await assert.rejects(restored.save(async update => update('external')), /未覆盖/);
});

test('matching external save becomes clean and unchanged editors accept external edits', () => {
  const session = new HtmlSourceSession(); session.load('original');
  session.receive('external'); assert.equal(session.text, 'external');
  session.text = 'draft'; session.receive('draft'); assert.equal(session.dirty, false);
});

test('a failed disk write keeps the draft dirty and can be retried', async () => {
  const session = new HtmlSourceSession(); session.load('base'); session.text = 'draft';
  await assert.rejects(session.save(async () => { throw new Error('disk full'); }), /disk full/);
  assert.equal(session.base, 'base'); assert.equal(session.text, 'draft'); assert.equal(session.dirty, true);
  await session.save(async update => update('base')); assert.equal(session.dirty, false);
});
