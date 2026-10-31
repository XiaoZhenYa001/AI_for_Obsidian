const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');

class TFile {
  constructor(path, content) {
    this.path = path;
    this.content = content;
    this.extension = 'md';
    this.stat = { size: content.length, mtime: 1, ctime: 1 };
  }
}
class TFolder {
  constructor(path) { this.path = path; }
}
const { ModificationService } = loadTs('src/modifications/modification-service.ts', {
  obsidian: { TFile, TFolder, normalizePath: (value) => value.replace(/\\/g, '/') }
});

function harness(initial = {}, hooks = {}) {
  const files = new Map(Object.entries(initial).map(([path, content]) => [path, new TFile(path, content)]));
  const savedSnapshots = [];
  const vault = {
    getAbstractFileByPath: (path) => files.get(path),
    read: async (file) => file.content,
    cachedRead: async (file) => file.content,
    modify: async (file, content) => {
      await hooks.beforeWrite?.(file, files);
      file.content = content;
      await hooks.afterWrite?.(file, files);
    },
    process: async (file, transform) => {
      await hooks.beforeWrite?.(file, files);
      const content = transform(file.content);
      file.content = content;
      await hooks.afterWrite?.(file, files);
      return content;
    },
    create: async (path, content) => {
      await hooks.beforeCreate?.(path, files);
      if (files.has(path)) throw new Error(`${path} already exists`);
      const file = new TFile(path, content);
      files.set(path, file);
      return file;
    },
    createFolder: async (path) => {
      if (files.has(path)) throw new Error(`${path} already exists`);
      files.set(path, new TFolder(path));
    }
  };
  const plugin = {
    settings: {},
    app: {
      vault,
      metadataCache: { getFileCache: (file) => hooks.getFileCache?.(file) },
      fileManager: {
        renameFile: async (file, target) => {
          if (files.has(target)) throw new Error(`${target} already exists`);
          files.delete(file.path);
          file.path = target;
          files.set(target, file);
        },
        trashFile: async (file) => {
          await hooks.beforeTrash?.(file, files);
          files.delete(file.path);
        }
      }
    },
    saveSettings: async () => {
      await hooks.beforeSave?.();
      savedSnapshots.push(structuredClone(plugin.settings.lastModificationSnapshot));
    }
  };
  return { plugin, files, savedSnapshots, service: new ModificationService(plugin) };
}

function plan(...items) {
  return { title: 'Test plan', rationale: 'Test', items: items.map((item, index) => ({ id: String(index), summary: 'Test', ...item })) };
}
function selected(plan) { return new Set(plan.items.map((item) => item.id)); }
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('undo refuses an occupied original rename path and retains the recovery snapshot', async () => {
  const { plugin, service, files } = harness({ 'A.md': 'original' });
  const change = plan({ operation: 'rename', path: 'A.md', targetPath: 'B.md', originalContent: 'original' });
  await service.applyPlan(change, selected(change));
  files.set('A.md', new TFile('A.md', 'new document'));

  await assert.rejects(service.undoLastBatch(), /A\.md/);
  assert.equal(files.get('A.md').content, 'new document');
  assert.equal(files.get('B.md').content, 'original');
  assert.equal(service.canUndo(), true);
  assert.equal(plugin.settings.lastModificationSnapshot.entries.length, 1);
});

test('a concurrent edit after batch validation is preserved and earlier writes are rolled back', async () => {
  const { service, files } = harness({ 'A.md': 'A original', 'B.md': 'B original' }, {
    afterWrite(file, entries) {
      if (file.path === 'A.md' && file.content === 'A AI') entries.get('B.md').content = 'B user edit';
    }
  });
  const change = plan(
    { operation: 'update', path: 'A.md', originalContent: 'A original', proposedContent: 'A AI' },
    { operation: 'update', path: 'B.md', originalContent: 'B original', proposedContent: 'B AI' }
  );

  await assert.rejects(service.applyPlan(change, selected(change)), /B\.md/);
  assert.equal(files.get('A.md').content, 'A original');
  assert.equal(files.get('B.md').content, 'B user edit');
  assert.equal(service.canUndo(), false);
});

test('an active batch excludes another apply and undo, and releases its lock afterward', async () => {
  const started = deferred();
  const release = deferred();
  const { service, files } = harness({ 'A.md': 'A original', 'B.md': 'B original' }, {
    async beforeWrite(file) {
      if (file.path === 'A.md') { started.resolve(); await release.promise; }
    }
  });
  const first = plan({ operation: 'update', path: 'A.md', originalContent: 'A original', proposedContent: 'A AI' });
  const second = plan({ operation: 'update', path: 'B.md', originalContent: 'B original', proposedContent: 'B AI' });
  const running = service.applyPlan(first, selected(first));
  await started.promise;
  try {
    await assert.rejects(service.applyPlan(second, selected(second)), /正在执行/);
    await assert.rejects(service.undoLastBatch(), /正在执行/);
    assert.equal(files.get('B.md').content, 'B original');
  } finally {
    release.resolve();
    await running;
  }
  assert.equal(await service.undoLastBatch(), 1);
  assert.equal(files.get('A.md').content, 'A original');
});

test('failed batch rollback preserves a newer edit and retains its unresolved recovery entry', async () => {
  const { plugin, service, files, savedSnapshots } = harness({ 'A.md': 'A original', 'B.md': 'B original' }, {
    beforeWrite(file, entries) {
      if (file.path === 'B.md') {
        entries.get('A.md').content = 'A user edit after AI write';
        throw new Error('B write failed');
      }
    }
  });
  const change = plan(
    { operation: 'update', path: 'A.md', originalContent: 'A original', proposedContent: 'A AI' },
    { operation: 'update', path: 'B.md', originalContent: 'B original', proposedContent: 'B AI' }
  );

  await assert.rejects(service.applyPlan(change, selected(change)), /B write failed/);
  assert.equal(files.get('A.md').content, 'A user edit after AI write');
  assert.equal(files.get('B.md').content, 'B original');
  assert.equal(service.canUndo(), true);
  assert.equal(plugin.settings.lastModificationSnapshot.entries.length, 1);
  assert.equal(plugin.settings.lastModificationSnapshot.entries[0].path, 'A.md');
  assert.equal(savedSnapshots.at(-1).entries[0].originalContent, 'A original');
});

test('rollback does not trash a newly created note that the user has edited', async () => {
  const { plugin, service, files } = harness({ 'B.md': 'B original' }, {
    beforeWrite(file, entries) {
      if (file.path === 'B.md') {
        entries.get('created.md').content = 'user additions';
        throw new Error('B write failed');
      }
    }
  });
  const change = plan(
    { operation: 'create', path: 'created.md', proposedContent: 'AI draft' },
    { operation: 'update', path: 'B.md', originalContent: 'B original', proposedContent: 'B AI' }
  );

  await assert.rejects(service.applyPlan(change, selected(change)), /B write failed/);
  assert.equal(files.get('created.md')?.content, 'user additions');
  assert.equal(plugin.settings.lastModificationSnapshot.entries[0].operation, 'create');
});

test('a partially completed undo persists only unresolved entries and can be retried', async () => {
  const { plugin, service, files, savedSnapshots } = harness({ 'A.md': 'A original', 'B.md': 'B original' }, {
    afterWrite(file, entries) {
      if (file.path === 'B.md' && file.content === 'B original') entries.get('A.md').content = 'A concurrent edit';
    }
  });
  const change = plan(
    { operation: 'update', path: 'A.md', originalContent: 'A original', proposedContent: 'A AI' },
    { operation: 'update', path: 'B.md', originalContent: 'B original', proposedContent: 'B AI' }
  );
  await service.applyPlan(change, selected(change));

  await assert.rejects(service.undoLastBatch(), /A\.md/);
  assert.equal(files.get('A.md').content, 'A concurrent edit');
  assert.equal(files.get('B.md').content, 'B original');
  assert.equal(plugin.settings.lastModificationSnapshot.entries.length, 1);
  assert.equal(savedSnapshots.at(-1).entries.length, 1);
  files.get('A.md').content = 'A AI';
  assert.equal(await service.undoLastBatch(), 1);
  assert.equal(files.get('A.md').content, 'A original');
  assert.equal(service.canUndo(), false);
});

test('an unresolved recovery snapshot survives reload and cannot be replaced by a new batch', async () => {
  const { plugin, service, files } = harness({ 'A.md': 'A original', 'B.md': 'B original' }, {
    beforeWrite(file, entries) {
      if (file.path === 'B.md') {
        entries.get('A.md').content = 'A concurrent edit';
        throw new Error('B write failed');
      }
    }
  });
  const failed = plan(
    { operation: 'update', path: 'A.md', originalContent: 'A original', proposedContent: 'A AI' },
    { operation: 'update', path: 'B.md', originalContent: 'B original', proposedContent: 'B AI' }
  );
  await assert.rejects(service.applyPlan(failed, selected(failed)));
  const reloaded = new ModificationService(plugin);
  const next = plan({ operation: 'create', path: 'new.md', proposedContent: 'new' });
  await assert.rejects(reloaded.applyPlan(next, selected(next)), /恢复/);
  assert.equal(files.has('new.md'), false);
  assert.equal(plugin.settings.lastModificationSnapshot.entries[0].path, 'A.md');

  files.get('A.md').content = 'A AI';
  await reloaded.undoLastBatch();
  assert.equal(await reloaded.applyPlan(next, selected(next)), 1);
});

test('a note edited while earlier items are applying is not deleted by the stale plan', async () => {
  const { service, files } = harness({ 'A.md': 'A original', 'B.md': 'B original' }, {
    afterWrite(file, entries) {
      if (file.path === 'A.md' && file.content === 'A AI') entries.get('B.md').content = 'B user edit';
    }
  });
  const change = plan(
    { operation: 'update', path: 'A.md', originalContent: 'A original', proposedContent: 'A AI' },
    { operation: 'delete', path: 'B.md', originalContent: 'B original' }
  );
  await assert.rejects(service.applyPlan(change, selected(change)), /B\.md/);
  assert.equal(files.get('A.md').content, 'A original');
  assert.equal(files.get('B.md')?.content, 'B user edit');
});

test('a mixed create, update, rename and delete batch still applies and undoes completely', async () => {
  const { service, files } = harness({ 'A.md': 'A original', 'B.md': 'B original', 'C.md': 'C original' });
  const change = plan(
    { operation: 'update', path: 'A.md', originalContent: 'A original', proposedContent: 'A AI' },
    { operation: 'rename', path: 'B.md', targetPath: 'folder/B.md', originalContent: 'B original' },
    { operation: 'delete', path: 'C.md', originalContent: 'C original' },
    { operation: 'create', path: 'folder/D.md', proposedContent: 'D AI' }
  );
  assert.equal(await service.applyPlan(change, selected(change)), 4);
  assert.equal(files.get('A.md').content, 'A AI');
  assert.equal(files.get('folder/B.md').content, 'B original');
  assert.equal(files.has('C.md'), false);
  assert.equal(files.get('folder/D.md').content, 'D AI');
  assert.equal(await service.undoLastBatch(), 4);
  assert.equal(files.get('A.md').content, 'A original');
  assert.equal(files.get('B.md').content, 'B original');
  assert.equal(files.get('C.md').content, 'C original');
  assert.equal(files.has('folder/B.md'), false);
  assert.equal(files.has('folder/D.md'), false);
  assert.equal(service.canUndo(), false);
});

test('failed recovery persistence reports both failures and keeps the in-memory snapshot', async () => {
  const { plugin, service, files } = harness({ 'A.md': 'A original', 'B.md': 'B original' }, {
    beforeWrite(file, entries) {
      if (file.path === 'B.md') {
        entries.get('A.md').content = 'A user edit';
        throw new Error('write failed');
      }
    },
    beforeSave() { throw new Error('settings disk failure'); }
  });
  const change = plan(
    { operation: 'update', path: 'A.md', originalContent: 'A original', proposedContent: 'A AI' },
    { operation: 'update', path: 'B.md', originalContent: 'B original', proposedContent: 'B AI' }
  );
  await assert.rejects(service.applyPlan(change, selected(change)), (error) => {
    assert.match(error.message, /write failed/);
    assert.match(error.message, /settings disk failure/);
    return true;
  });
  assert.equal(files.get('A.md').content, 'A user edit');
  assert.equal(service.canUndo(), true);
  assert.equal(plugin.settings.lastModificationSnapshot.entries[0].originalContent, 'A original');
});

test('failed undo bookkeeping remains retryable without writing restored files a second time', async () => {
  let failSave = false;
  const { service, files, savedSnapshots } = harness({ 'A.md': 'original' }, {
    beforeSave() { if (failSave) throw new Error('settings disk failure'); }
  });
  const change = plan({ operation: 'update', path: 'A.md', originalContent: 'original', proposedContent: 'AI' });
  await service.applyPlan(change, selected(change));
  failSave = true;
  await assert.rejects(service.undoLastBatch(), /settings disk failure/);
  assert.equal(files.get('A.md').content, 'original');
  assert.equal(service.canUndo(), true);

  files.get('A.md').content = 'new user edit';
  failSave = false;
  await service.undoLastBatch();
  assert.equal(files.get('A.md').content, 'new user edit');
  assert.equal(service.canUndo(), false);
  assert.equal(savedSnapshots.at(-1), undefined);
});

test('plan context excludes Excalidraw filenames and frontmatter-marked drawings', async () => {
  const { plugin, service } = harness({
    'Board.excalidraw.md': 'compressed drawing data',
    'Sketch.md': 'frontmatter drawing data',
    'Note.md': 'ordinary note'
  }, { getFileCache: file => ({ frontmatter: { 'excalidraw-plugin': file.path === 'Sketch.md' ? 'parsed' : undefined } }) });
  let prompt = '';
  plugin.chatService = { async sendMessage(content) {
    prompt = content;
    return { content: JSON.stringify(plan({ operation: 'update', path: 'Note.md', edits: [{ oldText: 'ordinary', newText: 'updated' }] })) };
  } };
  const result = await service.createPlan('update notes', ['Board.excalidraw.md', 'Sketch.md', 'Note.md']);
  assert.doesNotMatch(prompt, /compressed drawing|frontmatter drawing|Board\.excalidraw|Sketch\.md/);
  assert.equal(result.items[0].path, 'Note.md');
  assert.equal(result.items[0].proposedContent, 'updated note');
  await assert.rejects(service.createPlan('edit drawing', ['Board.excalidraw.md', 'Sketch.md']), /AI 编辑画布内容/);
});

test('plan reports included and skipped files with their actual selection reasons', async () => {
  const notes = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`note${index}.md`, index === 1 ? 'x'.repeat(90001) : `text ${index}`]));
  const { plugin, service } = harness(notes);
  let prompt = '';
  plugin.chatService = { async sendMessage(content) {
    prompt = content;
    return { content: JSON.stringify(plan({ operation: 'update', path: 'note0.md', edits: [{ oldText: 'text 0', newText: 'changed' }] })) };
  } };
  const result = await service.createPlan('update', [...Object.keys(notes), 'missing.md']);
  assert.equal(result.coverage.included.length, 23);
  assert.deepEqual(JSON.parse(JSON.stringify(result.coverage.skipped)), [
    { path: 'missing.md', reason: '文件不存在或不是文件' },
    { path: 'note1.md', reason: '超出本次内容大小预算' },
    { path: 'note24.md', reason: '超出前 24 个文件的限制' }
  ]);
  assert.match(prompt, /note0\.md/);
  assert.doesNotMatch(prompt, /note1\.md|note24\.md|missing\.md/);
});

test('generic apply refuses existing drawings even when a plan bypasses generation', async () => {
  for (const path of ['Board.excalidraw.md', 'Sketch.md']) {
    for (const operation of ['update', 'rename', 'delete']) {
      const { service, files } = harness({ [path]: 'drawing data' }, {
        getFileCache: file => ({ frontmatter: { 'excalidraw-plugin': file.path === 'Sketch.md' ? 'parsed' : undefined } })
      });
      const change = plan({ operation, path, targetPath: operation === 'rename' ? 'Renamed.md' : undefined, originalContent: 'drawing data', proposedContent: 'broken drawing' });
      await assert.rejects(service.applyPlan(change, selected(change)), /AI 编辑画布内容/);
      assert.equal(files.get(path).content, 'drawing data');
      assert.equal(files.has('Renamed.md'), false);
    }
  }
});

test('generic create and rename cannot produce files with an Excalidraw extension', async () => {
  for (const operation of ['create', 'rename']) {
    const { plugin, service, files } = harness({ 'Note.md': 'ordinary note' });
    const change = plan({ operation, path: operation === 'create' ? 'New.Excalidraw.md' : 'Note.md', targetPath: operation === 'rename' ? 'New.Excalidraw.md' : undefined, originalContent: 'ordinary note', proposedContent: 'plain markdown' });
    plugin.chatService = { async sendMessage() { return { content: JSON.stringify(change) }; } };
    await assert.rejects(service.createPlan('create a note', ['Note.md']), /安全执行/);
    await assert.rejects(service.applyPlan(change, selected(change)), /AI 编辑画布内容/);
    assert.equal(files.get('Note.md').content, 'ordinary note');
    assert.equal(files.has('New.Excalidraw.md'), false);
  }
});
