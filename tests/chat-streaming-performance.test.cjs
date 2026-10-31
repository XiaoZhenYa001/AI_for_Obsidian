const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs, obsidian } = require('./helpers/load-ts.cjs');

function fixture() {
  const timers = new Map(); let nextId = 0, markdown = 0, mermaid = 0;
  const doc = { hidden: false, defaultView: {
    setTimeout(fn) { timers.set(++nextId, fn); return nextId; },
    clearTimeout(id) { timers.delete(id); }
  }, createTextNode(data) { return { nodeType: 3, data, get length() { return this.data.length; }, appendData(suffix) { this.data += suffix; } }; } };
  class Element {
    constructor(cls = '') { this.nodeType = 1; this.children = []; this.classes = new Set(cls.split(' ')); this.ownerDocument = doc; this.isConnected = true; this.scrollTop = 0; this.scrollHeight = 1000; this.clientHeight = 500; }
    get firstChild() { return this.children[0]; }
    get lastElementChild() { return this.children.filter(node => node.nodeType === 1).at(-1); }
    addClass(value) { this.classes.add(value); }
    removeClass(value) { this.classes.delete(value); }
    empty() { this.children.forEach(node => { node.isConnected = false; }); this.children = []; }
    appendChild(node) { this.children.push(node); return node; }
    createDiv(options = {}) { const element = new Element(options.cls); this.appendChild(element); if (options.text) element.setText(options.text); return element; }
    createSpan(options) { return this.createDiv(options); }
    setText(text) { this.empty(); this.appendChild(doc.createTextNode(text)); }
    querySelector(selector) { for (const child of this.children) { if (child.nodeType !== 1) continue; if (child.classes.has(selector.slice(1))) return child; const found = child.querySelector(selector); if (found) return found; } return null; }
    querySelectorAll(selector) { const result = []; for (const child of this.children) { if (child.nodeType !== 1) continue; if (child.classes.has(selector.slice(1))) result.push(child); result.push(...child.querySelectorAll(selector)); } return result; }
  }
  const { AIChatView } = loadTs('src/chat/chat-view.ts', {
    obsidian: { ...obsidian, MarkdownRenderer: { async render(_app, text, target) { markdown++; target.setText(text); } } },
    'src/ui/mermaid-artifact.ts': { extractMermaidSources: () => [], enhanceMermaidArtifacts: () => mermaid++ }
  });
  const view = new AIChatView({}, { getEditableMarkdownView: () => undefined });
  view.containerEl = new Element(); view.messagesEl = new Element(); view.app = {};
  view.renderAssistantActions = () => {}; view.enhanceInlineCitations = () => {};
  const message = { role: 'assistant', content: '```mermaid\n', isComplete: false, status: 'streaming' };
  view.messages = [message]; view.renderMessages();
  function flush() { const pending = [...timers]; timers.clear(); for (const [, fn] of pending) fn(); }
  return { view, message, doc, timers, flush, counts: () => ({ markdown, mermaid }),
    content: () => view.messagesEl.querySelector('.ai-second-brain-message-content') };
}

test('300 stream deltas coalesce into 100 text updates with zero Markdown/Mermaid calls', async () => {
  const f = fixture(); const text = f.content().firstChild;
  f.view.messagesEl.scrollTop = 20;
  for (let batch = 0; batch < 100; batch++) {
    for (let delta = 0; delta < 3; delta++) { f.message.content += 'A-->B\n'; f.view.scheduleLastMessageContentUpdate(f.message); }
    assert.equal(f.timers.size, 1); f.flush();
  }
  assert.equal(f.content().firstChild, text);
  assert.equal(text.data, f.message.content); assert.equal(f.view.messagesEl.scrollTop, 20);
  assert.deepEqual(f.counts(), { markdown: 0, mermaid: 0 });
  f.message.content += '```'; f.message.isComplete = true; f.message.status = 'complete';
  f.view.renderMessages(false); await Promise.resolve();
  assert.deepEqual(f.counts(), { markdown: 1, mermaid: 1 });
  assert.equal(f.timers.size, 0);
});

test('hidden streams have no scheduled updates and render the final answer once on return', async () => {
  const f = fixture(); const original = f.content().firstChild.data;
  f.view.scheduleLastMessageContentUpdate(f.message);
  f.view.viewVisible = false; f.view.updateRenderVisibility(); assert.equal(f.timers.size, 0);
  for (let i = 0; i < 100; i++) { f.message.content += 'delta'; f.view.scheduleLastMessageContentUpdate(f.message); }
  assert.equal(f.timers.size, 0); assert.equal(f.content().firstChild.data, original);
  f.message.isComplete = true; f.message.status = 'complete'; f.view.renderMessages();
  assert.deepEqual(f.counts(), { markdown: 0, mermaid: 0 });
  f.view.viewVisible = true; f.view.updateRenderVisibility(); await Promise.resolve();
  assert.equal(f.content().firstChild.data, f.message.content);
  assert.deepEqual(f.counts(), { markdown: 1, mermaid: 1 }); assert.equal(f.timers.size, 0);
});

test('window visibility resumes partial output and closed views cannot schedule more work', async () => {
  const f = fixture();
  f.doc.hidden = true; f.view.updateRenderVisibility();
  f.message.content += 'latest'; f.view.scheduleLastMessageContentUpdate(f.message); assert.equal(f.timers.size, 0);
  f.doc.hidden = false; f.view.updateRenderVisibility(); f.flush();
  assert.equal(f.content().firstChild.data, f.message.content);
  f.view.scheduleLastMessageContentUpdate(f.message); await f.view.onClose();
  f.view.scheduleLastMessageContentUpdate(f.message); f.view.updateRenderVisibility();
  assert.equal(f.timers.size, 0); assert.deepEqual(f.counts(), { markdown: 0, mermaid: 0 });
});
