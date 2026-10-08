const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');
const { HtmlDraftStore } = loadTs('src/html/html-draft-store.ts');
function fixture() {
  const values = new Map();
  return () => new HtmlDraftStore(key => values.get(key), (key, value) => values.set(key, JSON.parse(JSON.stringify(value))));
}
test('independent editor drafts survive clean-tab closure and saving another draft', () => {
  const create = fixture(); const one = create(), two = create(), clean = create();
  one.persist('a.html', 'base', 'one'); two.persist('a.html', 'base', 'two');
  clean.persist('a.html', 'base', 'base');
  const recovered = create(); const draft = recovered.restore('a.html');
  assert.ok(['one', 'two'].includes(draft.text));
  recovered.persist('a.html', draft.text, draft.text);
  const other = create().restore('a.html');
  assert.ok(other); assert.notEqual(other.text, draft.text);
});
test('renamed draft restores at the new path without leaving an owned old draft', () => {
  const create = fixture(), store = create();
  store.persist('old.html', 'base', 'edit'); store.rename('old.html', 'new.html', 'base', 'edit');
  assert.equal(create().restore('old.html'), undefined);
  assert.equal(create().restore('new.html').text, 'edit');
});

test('a failed rename storage write leaves the original recovery draft intact', () => {
  const values = new Map();
  let fail = false;
  const read = key => values.get(key);
  const write = (key, value) => { if (fail) throw new Error('quota'); values.set(key, value); };
  const store = new HtmlDraftStore(read, write);
  store.persist('old.html', 'base', 'unsaved'); fail = true;
  assert.throws(() => store.rename('old.html', 'new.html', 'base', 'unsaved'), /quota/);
  assert.equal(new HtmlDraftStore(read, write).restore('old.html').text, 'unsaved');
});
