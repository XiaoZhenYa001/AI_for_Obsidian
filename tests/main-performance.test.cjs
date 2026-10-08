const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');
const Plugin = loadTs('src/main.ts').default;

async function fixture() {
  const plugin = new Plugin();
  plugin.loadData = async () => ({});
  await plugin.loadSettings();
  const calls = { providers: 0, templates: 0, status: 0, chat: 0, writes: 0 };
  plugin.providerRegistry = { update: () => calls.providers++ };
  plugin.templateService = { update: () => calls.templates++ };
  plugin.refreshStatusBar = () => calls.status++;
  plugin.refreshChatViews = () => calls.chat++;
  plugin.saveData = async () => { calls.writes++; };
  await plugin.saveSettings();
  Object.keys(calls).forEach(key => { calls[key] = 0; });
  return { plugin, calls };
}

test('history persistence does not rebuild services or refresh unchanged context controls', async () => {
  const { plugin, calls } = await fixture();
  const id = plugin.settings.activeChatSessionId;
  const messages = [];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: `message ${i}`, createdAt: new Date().toISOString() });
    await plugin.saveChatSessionMessages(id, messages);
  }
  assert.deepEqual(calls, { providers: 0, templates: 0, status: 0, chat: 0, writes: 20 });
  assert.equal(plugin.getActiveChatSession().messages.length, 20);
});

test('in-place provider, template and context edits still reach their consumers', async () => {
  const { plugin, calls } = await fixture();
  plugin.settings.providers.push({ id: 'local', name: 'Local', enabled: true, type: 'ollama' });
  await plugin.saveSettings();
  assert.equal(calls.providers, 1);
  assert.equal(calls.status, 1);
  assert.equal(calls.chat, 0);
  plugin.settings.providers[0].enabled = false;
  await plugin.saveSettings();
  assert.equal(calls.providers, 2);
  plugin.settings.promptTemplates[0].prompt += '\nChanged instruction';
  await plugin.saveSettings();
  assert.equal(calls.templates, 1);
  plugin.getActiveChatSession().contextFilePath = 'renamed.md';
  await plugin.saveSettings();
  assert.equal(calls.chat, 1);
  plugin.settings.defaultChatProviderId = 'other';
  await plugin.saveSettings();
  assert.equal(calls.chat, 2);
  assert.equal(calls.providers, 2);
  assert.equal(calls.status, 4);
});

test('a rejected settings write does not prevent the next save or apply stale runtime state', async () => {
  const { plugin, calls } = await fixture();
  const applied = [];
  plugin.providerRegistry.update = configs => applied.push(configs[0].name);
  plugin.settings.providers = [{ id: 'provider', name: 'first', enabled: true }];
  let release;
  plugin.saveData = async () => {
    if (!release) await new Promise((resolve, reject) => { release = () => reject(new Error('disk full')); });
  };
  const failed = plugin.saveSettings();
  await Promise.resolve();
  plugin.settings.providers[0].name = 'latest';
  const next = plugin.saveSettings();
  release();
  await assert.rejects(failed, /disk full/);
  await next;
  assert.deepEqual(applied, ['latest']);
  assert.equal(calls.chat, 0);
});

test('file-event bursts use one deferred status refresh and unload cancels pending work', () => {
  const scheduled = new Map();
  let nextId = 0;
  const TimedPlugin = loadTs('src/main.ts', {}, {
    setTimeout: callback => { scheduled.set(++nextId, callback); return nextId; },
    clearTimeout: id => scheduled.delete(id)
  }).default;
  const plugin = new TimedPlugin();
  plugin.app = { workspace: { detachLeavesOfType() {} } };
  let refreshes = 0;
  plugin.refreshStatusBar = () => refreshes++;
  for (let i = 0; i < 100; i++) plugin.scheduleStatusBarRefresh();
  assert.equal(scheduled.size, 1);
  const [id, callback] = scheduled.entries().next().value;
  scheduled.delete(id);
  callback();
  assert.equal(refreshes, 1);
  assert.equal(scheduled.size, 0);
  plugin.scheduleStatusBarRefresh();
  plugin.onunload();
  assert.equal(scheduled.size, 0);
});

test('unchanged status content causes no DOM writes, while a count change reuses existing nodes', () => {
  const plugin = new Plugin();
  let creates = 0;
  let textWrites = 0;
  let label;
  let files = [{ name: 'note.md' }];
  const button = {
    querySelector: () => label,
    createSpan: ({ cls }) => {
      creates++;
      const element = { setText: text => { textWrites++; element.text = text; } };
      if (cls.endsWith('-label')) label = element;
      return element;
    },
    toggleClass() {}
  };
  plugin.statusBarEl = { querySelector: () => button };
  plugin.settings = {};
  plugin.providerRegistry = { get: () => ({ config: { name: 'Local' } }) };
  plugin.contextScopeResolver = { resolve: () => files };
  plugin.getActiveContextScope = () => ({ name: 'Notes' });
  plugin.getActiveChatSession = () => ({ contextMode: 'manual' });
  plugin.refreshStatusBar();
  for (let i = 0; i < 10; i++) plugin.refreshStatusBar();
  assert.equal(creates, 2);
  assert.equal(textWrites, 1);
  files = [...files, { name: 'new.md' }];
  plugin.refreshStatusBar();
  assert.equal(creates, 2);
  assert.equal(textWrites, 2);
  assert.equal(label.text, 'Notes · 2');
});
