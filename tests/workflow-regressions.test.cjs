const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs, TFile } = require('./helpers/load-ts.cjs');
const Plugin = loadTs('src/main.ts').default;

test('a confirmed folder keeps every selected file on save and reload while pins remain capped', async () => {
  const plugin = new Plugin();
  plugin.loadData = async () => ({});
  await plugin.loadSettings();
  plugin.saveSettings = async () => {};
  const session = plugin.getActiveChatSession();
  const paths = Array.from({ length: 24 }, (_, i) => `project/note-${i}.md`);
  paths.push('project/board.canvas', 'project/drawing.excalidraw');
  await plugin.saveChatSessionContext(session.id, paths, paths, 'confirmed');
  assert.equal(session.lastContextFilePaths.length, 26);
  assert.equal(session.lockedFilePaths.length, 8);
  const persisted = JSON.parse(JSON.stringify(plugin.settings));
  plugin.loadData = async () => persisted;
  await plugin.loadSettings();
  assert.equal(plugin.getActiveChatSession().lastContextFilePaths.length, 26);
});

test('an explicitly empty context selection is reused until the scope changes', async () => {
  let confirmations = 0;
  const { AIChatView } = loadTs('src/chat/chat-view.ts', {
    '../context/context-selection-modal': { confirmContextSelection: async () => {
      confirmations++;
      return { selectedFilePaths: [], lockedFilePaths: [] };
    } }
  });
  const file = new TFile('note.md');
  const session = { id: 'chat', autoContext: true, contextMode: 'manual', lockedFilePaths: [], lastContextFilePaths: [], lastContextFingerprint: '' };
  const scope = { id: 'scope', files: [file.path] };
  const requests = [];
  const plugin = {
    settings: { chatSessions: [session] },
    getActiveChatSession: () => session,
    getActiveContextScope: () => scope,
    getChatSessionContextScope: () => scope,
    getPendingSelectionReferences: () => [], clearPendingSelectionReferences() {},
    contextScopeResolver: { resolve: () => [file] },
    textSearchService: { rankFiles: async () => [] },
    async saveChatSessionContext(_id, selected, locked, fingerprint) {
      session.lastContextFilePaths = selected;
      session.lockedFilePaths = locked;
      session.lastContextFingerprint = fingerprint;
    },
    async saveChatSessionMessages() {},
    chatService: { async streamMessage(_content, options) {
      requests.push(options);
      return { citations: [], stream: (async function* () { yield 'answer'; })() };
    } }
  };
  const view = new AIChatView({}, plugin);
  view.app = { vault: { getAllLoadedFiles: () => [] }, metadataCache: { getFileCache: () => ({}) } };
  view.activeSessionId = 'chat';
  view.inputEl = { value: 'question' };
  view.renderMessages = () => {};
  view.scheduleLastMessageContentUpdate = () => {};
  await view.submit();
  view.inputEl.value = 'another question';
  await view.submit();
  assert.equal(confirmations, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].contextFilePaths.length, 0);
  file.path = 'another.md';
  view.inputEl.value = 'question after changing scope';
  await view.submit();
  assert.equal(confirmations, 2);
});

test('a new chat expires and saves the old drawing preview and resets drawing mode', async () => {
  const { AIChatView } = loadTs('src/chat/chat-view.ts', {
    './chat-session-modal': { configureChatSession: async () => ({}) }
  });
  const oldReply = { role: 'assistant', content: 'preview', status: 'complete', drawing: { path: 'board.excalidraw', state: 'preview' } };
  const saved = [];
  const plugin = {
    settings: { activeContextScopeId: 'current-file', chatSessions: [] },
    getPendingSelectionReferences: () => [],
    async createChatSession() { return { id: 'new' }; },
    async saveChatSessionMessages(id, messages) { saved.push({ id, messages: JSON.parse(JSON.stringify(messages)) }); }
  };
  const view = new AIChatView({}, plugin);
  view.activeSessionId = 'old';
  view.messages = [oldReply];
  view.inputEl = { value: 'draft', focus() {} };
  view.drawingTarget = new TFile('board.excalidraw');
  view.pendingDrawing = { message: oldReply };
  view.renderMessages = () => {};
  await view.startNewSession();
  assert.equal(view.drawingTarget, undefined);
  assert.equal(view.pendingDrawing, undefined);
  assert.equal(saved[0].id, 'old');
  assert.equal(saved[0].messages[0].drawing.state, 'expired');
  assert.equal(view.inputEl.value, '');
});

test('health analysis excludes drawing internals and Canvas documents', async () => {
  const { KnowledgeAnalysisService } = loadTs('src/knowledge/analysis-service.ts');
  const files = ['note.md', 'board.excalidraw.md', 'marked.md', 'board.canvas'].map(path => new TFile(path));
  const reads = [];
  const service = new KnowledgeAnalysisService({
    vault: { cachedRead: async file => { reads.push(file.path); return '# Note'; } },
    metadataCache: { resolvedLinks: {}, getFileCache: file => ({ frontmatter: file.path === 'marked.md' ? { 'excalidraw-plugin': 'parsed' } : {} }) }
  });
  const report = await service.analyze('scope', files);
  assert.deepEqual(reads, ['note.md']);
  assert.equal(report.notes.length, 1);
});

test('invalidating parsed metadata refreshes health report without file stat changes', async () => {
  const { KnowledgeAnalysisService } = loadTs('src/knowledge/analysis-service.ts');
  const files = [new TFile('one.md'), new TFile('two.md')];
  const metadata = { resolvedLinks: {}, getFileCache: () => ({}) };
  const service = new KnowledgeAnalysisService({ vault: { cachedRead: async () => 'content' }, metadataCache: metadata });
  const before = await service.analyze('scope', files);
  assert.equal(before.isolatedNotes.length, 2);
  metadata.resolvedLinks['one.md'] = { 'two.md': 1 };
  service.invalidate?.();
  const after = await service.analyze('scope', files);
  assert.equal(after.isolatedNotes.length, 0);
});

test('closing content generation aborts its request and ignores a late model response', async () => {
  const { GenerateContentModal } = loadTs('src/actions/generate-content-modal.ts');
  let finish, signal;
  const modal = new GenerateContentModal({}, {
    settings: { defaultEditProviderId: 'edit' },
    getActiveContextScope: () => undefined,
    chatService: { sendMessage: (_prompt, options) => {
      signal = options.signal;
      return new Promise(resolve => { finish = resolve; });
    } }
  });
  modal.prompt = 'write a summary';
  modal.renderPreview = () => {};
  modal.renderCitations = () => {};
  const pending = modal.generate();
  modal.onClose();
  assert.equal(signal?.aborted, true);
  finish({ content: 'late answer', citations: [] });
  await pending;
  assert.equal(modal.generatedContent, '');
});

test('closing a modification preview cancels generation and drops a late plan', async () => {
  const { ModificationPlanModal } = loadTs('src/modifications/modification-plan-modal.ts');
  let finish, signal;
  const modal = new ModificationPlanModal({}, {
    modificationService: { createPlan: (_objective, _files, requestSignal) => {
      signal = requestSignal;
      return new Promise(resolve => { finish = resolve; });
    } }
  }, 'organize notes', ['note.md']);
  modal.renderPlan = () => { throw new Error('A closed modal must not render a late plan'); };
  const pending = modal.generate();
  modal.onClose?.();
  assert.equal(signal?.aborted, true);
  finish({ title: 'late plan', items: [] });
  await pending;
  assert.equal(modal.plan, undefined);
});

test('cancelling a modification request while reading files prevents a model call', async () => {
  const { ModificationService } = loadTs('src/modifications/modification-service.ts');
  const file = new TFile('note.md');
  let finish, calls = 0;
  const service = new ModificationService({
    settings: {},
    app: { vault: { getAbstractFileByPath: () => file, cachedRead: () => new Promise(resolve => { finish = resolve; }) }, metadataCache: { getFileCache: () => ({}) } },
    chatService: { async sendMessage() { calls++; return { content: '{}' }; } }
  });
  const controller = new AbortController();
  const pending = service.createPlan('organize', ['note.md'], controller.signal);
  controller.abort();
  finish('original content');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 0);
});
