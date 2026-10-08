const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');
const Plugin = loadTs('src/main.ts').default;

test('native HTML preview defaults off and retains an explicit opt-in across reloads', async () => {
  const plugin = new Plugin();
  plugin.loadData = async () => ({});
  await plugin.loadSettings();
  assert.equal(plugin.settings.enableHtmlPreview, false);
  plugin.loadData = async () => ({ enableHtmlPreview: true });
  await plugin.loadSettings();
  assert.equal(plugin.settings.enableHtmlPreview, true);
});

test('disabling native HTML closes existing preview views and persists the preference', async () => {
  const plugin = new Plugin();
  plugin.settings = { enableHtmlPreview: true };
  const closed = [];
  plugin.app = { workspace: { detachLeavesOfType: type => closed.push(type) } };
  let saved;
  plugin.saveSettings = async () => { saved = plugin.settings.enableHtmlPreview; };
  await plugin.setHtmlPreviewEnabled(false);
  assert.equal(saved, false);
  assert.deepEqual(closed, ['ai-second-brain-html-preview']);
  await assert.rejects(plugin.openHtmlPreview({path:'page.html'}), /启用 HTML 原生预览/);
});
