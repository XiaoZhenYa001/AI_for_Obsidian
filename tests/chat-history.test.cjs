const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');
const Plugin = loadTs('src/main.ts').default;
const { toViewMessage, toProviderHistory } = loadTs('src/chat/chat-view.ts');

function message(index, status = 'complete') {
  return { role: index % 2 ? 'assistant' : 'user', content: `message ${index}`, status, createdAt: '2026-09-22T00:00:00.000Z' };
}
function pluginWith(sessions) {
  const plugin = new Plugin();
  plugin.settings = { chatSessions: sessions, activeContextScopeId: 'current-file' };
  plugin.saveSettings = async () => {};
  plugin.getActiveContextFilePath = () => 'note.md';
  return plugin;
}

test('saving a long conversation preserves all messages', async () => {
  const plugin = pluginWith([{ id: 'chat', title: 'chat', messages: [] }]);
  await plugin.saveChatSessionMessages('chat', Array.from({ length: 100 }, (_, i) => message(i)));
  assert.equal(plugin.settings.chatSessions[0].messages.length, 100);
  assert.equal(plugin.settings.chatSessions[0].messages[0].content, 'message 0');
});

test('creating session 31 keeps every existing session', async () => {
  const plugin = pluginWith(Array.from({ length: 30 }, (_, i) => ({ id: `chat-${i}`, messages: [] })));
  await plugin.createChatSession();
  assert.equal(plugin.settings.chatSessions.length, 31);
  assert.ok(plugin.settings.chatSessions.some(s => s.id === 'chat-29'));
});

test('loading history preserves message status and archived sessions', async () => {
  const plugin = pluginWith([]);
  plugin.loadData = async () => ({ chatSessions: [{ id: 'saved', title: 'saved', archived: true, messages: [message(1, 'error'), message(3, 'stopped')] }] });
  await plugin.loadSettings();
  const session = plugin.settings.chatSessions.find(s => s.id === 'saved');
  assert.equal(session.archived, true);
  assert.equal(session.messages[0].status, 'error');
  assert.equal(session.messages[1].status, 'stopped');
});

test('loading persisted data does not truncate sessions or messages', async () => {
  const plugin = pluginWith([]);
  plugin.loadData = async () => ({ chatSessions: Array.from({ length: 35 }, (_, i) => ({ id: `chat-${i}`, messages: Array.from({ length: 70 }, (_, j) => message(j)) })) });
  await plugin.loadSettings();
  assert.equal(plugin.settings.chatSessions.length, 35);
  assert.equal(plugin.settings.chatSessions[0].messages.length, 70);
});

test('failed and stopped answers keep their status after reload and stay out of provider history', () => {
  const restored = [message(1, 'error'), message(3, 'stopped'), message(5)].map(toViewMessage);
  assert.equal(restored[0].status, 'error');
  assert.equal(restored[1].status, 'stopped');
  const history = toProviderHistory(restored);
  assert.equal(history.length, 1);
  assert.equal(history[0].content, 'message 5');
});

test('settings saves cannot complete out of order and each write captures its own state', async () => {
  const plugin = new Plugin();
  plugin.settings = { value: 'first' };
  plugin.refreshStatusBar = () => {};
  plugin.refreshChatViews = () => {};
  const seen = [];
  let release;
  plugin.saveData = async (data) => {
    seen.push(data.value);
    if (seen.length === 1) await new Promise(resolve => { release = resolve; });
  };
  const first = plugin.saveSettings();
  await Promise.resolve();
  plugin.settings.value = 'second';
  const second = plugin.saveSettings();
  await Promise.resolve();
  assert.deepEqual(seen, ['first']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(seen, ['first', 'second']);
});
