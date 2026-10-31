const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs, TFile } = require('./helpers/load-ts.cjs');
const { investigateFiles } = loadTs('src/modifications/file-agent.ts');
const { ModificationService } = loadTs('src/modifications/modification-service.ts');

function harness(actions) {
  const note = new TFile('notes/a.md');
  const secret = new TFile('private/secret.md');
  const files = new Map([[note.path, note], [secret.path, secret]]);
  const contents = new Map([[note.path, 'one\ntwo\n'], [secret.path, 'private']]);
  const sent = [];
  const scope = { allowCloudModels: false };
  const plugin = {
    settings: { defaultEditProviderId: 'model' },
    getActiveContextScope: () => scope,
    contextScopeResolver: { resolve: () => [note] },
    app: { vault: { getAbstractFileByPath: path => files.get(path), read: async file => contents.get(file.path) }, metadataCache: { getFileCache: () => null } },
    chatService: { sendMessage: async (content, options) => {
      sent.push({ content, options });
      return { content: JSON.stringify(actions.shift()) };
    } }
  };
  return { plugin, contents, sent, scope };
}
const finish = (path = 'notes/a.md', oldText = 'two') => ({ action: 'finish', items: [{ operation: 'update', path, edits: [{ oldText, newText: 'changed' }] }] });

test('investigates authorized files and creates a preview without writing', async () => {
  const h = harness([{ action: 'list', query: 'notes' }, { action: 'read', path: 'notes/a.md' }, finish()]);
  const plan = await investigateFiles(h.plugin, 'change two', new AbortController().signal);
  assert.equal(plan.items[0].originalContent, 'one\ntwo\n');
  assert.equal(plan.items[0].proposedContent, 'one\nchanged\n');
  assert.equal(h.contents.get('notes/a.md'), 'one\ntwo\n');
  assert.equal(h.sent[0].options.contextScope, h.scope);
  assert.match(h.sent[2].content, /notes\/a\.md/);
});

test('cannot read or propose edits to unauthorized or unread files', async () => {
  const h = harness([{ action: 'read', path: 'private/secret.md' }, finish('private/secret.md', 'private')]);
  await assert.rejects(investigateFiles(h.plugin, 'edit', new AbortController().signal), /只能修改已读取/);
  assert.doesNotMatch(h.sent[1].content, /"content":"private"/);
});

test('rejects ambiguous edits and does not silently apply a partial plan', async () => {
  const h = harness([{ action: 'read', path: 'notes/a.md' }, finish('notes/a.md', 'o')]);
  await assert.rejects(investigateFiles(h.plugin, 'edit', new AbortController().signal), /不唯一/);
  assert.equal(h.contents.get('notes/a.md'), 'one\ntwo\n');
});

test('new files are limited to the folder of a read authorized note', async () => {
  const create = path => ({ action: 'finish', items: [{ operation: 'create', path, proposedContent: 'draft' }] });
  const h = harness([{ action: 'read', path: 'notes/a.md' }, create('notes/new.md')]);
  const plan = await investigateFiles(h.plugin, 'create a note', new AbortController().signal);
  assert.equal(plan.items[0].path, 'notes/new.md');
  assert.equal(plan.items[0].operation, 'create');
  assert.equal(h.contents.has('notes/new.md'), false);
  for (const path of ['private/new.md', 'notes/../private/new.md', 'notes/.hidden.md', 'notes/a.md']) {
    const denied = harness([{ action: 'read', path: 'notes/a.md' }, create(path)]);
    await assert.rejects(investigateFiles(denied.plugin, 'create', new AbortController().signal), /无效/);
  }
});

test('reviewed agent plan applies and can be undone, while a stale plan is rejected', async () => {
  const h = harness([{ action: 'read', path: 'notes/a.md' }, finish()]);
  h.plugin.app.vault.process = async (file, transform) => {
    const result = transform(h.contents.get(file.path));
    h.contents.set(file.path, result);
    return result;
  };
  h.plugin.saveSettings = async () => {};
  const plan = await investigateFiles(h.plugin, 'change two', new AbortController().signal);
  const service = new ModificationService(h.plugin);
  const selected = new Set([plan.items[0].id]);
  h.contents.set('notes/a.md', 'user edit');
  await assert.rejects(service.applyPlan(plan, selected), /发生了变化/);
  assert.equal(h.contents.get('notes/a.md'), 'user edit');
  h.contents.set('notes/a.md', 'one\ntwo\n');
  assert.equal(await service.applyPlan(plan, selected), 1);
  assert.equal(h.contents.get('notes/a.md'), 'one\nchanged\n');
  await service.undoLastBatch();
  assert.equal(h.contents.get('notes/a.md'), 'one\ntwo\n');
});

test('cancellation before investigation makes no model request', async () => {
  const h = harness([]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(investigateFiles(h.plugin, 'edit', controller.signal));
  assert.equal(h.sent.length, 0);
});
